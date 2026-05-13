/**
 * Executor module — orchestrates DLMM setup and builds unsigned transactions
 * for the integrated test page.
 *
 * The heavy lifting is split across three builders under `./builders/`:
 *
 *   - `DlmmPoolBuilder`   — pool creation + adoption + bin-array setup
 *   - `TokenFactory`      — test-only SPL mint utilities
 *   - `LiquidityPlanner`  — init / add_liquidity / claim_fees / withdraw_close
 *
 * This file just constructs the Anchor provider/program once, hands them to
 * each builder, and exposes a flat API for the controller.
 */

import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import DLMM, { binIdToBinArrayIndex, deriveBinArray } from "@meteora-ag/dlmm";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getPrices } from "#modules/prices";
import { resolveDlmmProgram } from "#common/solana/dlmm-program";
import { loadConfig } from "#common/config";

import { DlmmSwapClient, type BuildSwapTxArgs, type BuildSwapTxResult } from "./clients/dlmm-swap.client.js";
import { DlmmPoolBuilder } from "./builders/dlmm-pool.builder.js";
import { TokenFactory } from "./builders/token.factory.js";
import { LiquidityPlanner } from "./builders/liquidity.planner.js";
import { derivePoolAuthorityPda } from "./builders/pool-authority.js";
import type { BuilderContext } from "./builders/types.js";
import type { DistributionShape } from "./single-sided.js";

export type { TestPairConfig } from "./builders/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDL_PATH = join(__dirname, "..", "execution", "clients", "idl", "octora_executor.json");

export interface ExecutorServiceConfig {
  rpcUrl: string;
  /** Hot wallet that pays fees, owns the mint authority for test mints, and acts as DLMM funder. */
  relayerKeypair: Keypair;
  /** Deployed octora-executor program id. */
  executorProgramId: PublicKey;
}

export class ExecutorService {
  private connection: Connection;
  private relayer: Keypair;
  private programId: PublicKey;
  private program: Program;
  private swapClient: DlmmSwapClient;

  private poolBuilder: DlmmPoolBuilder;
  private tokenFactory: TokenFactory;
  private liquidityPlanner: LiquidityPlanner;

  constructor(config: ExecutorServiceConfig) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.relayer = config.relayerKeypair;
    this.programId = config.executorProgramId;

    const wallet = new Wallet(this.relayer);
    const provider = new AnchorProvider(this.connection, wallet, { commitment: "confirmed" });
    const idl = JSON.parse(readFileSync(IDL_PATH, "utf-8"));
    this.program = new Program(idl, provider);
    this.swapClient = new DlmmSwapClient({
      rpcUrl: config.rpcUrl,
      relayerKeypair: config.relayerKeypair,
      executorProgramId: config.executorProgramId,
    });

    const ctx: BuilderContext = {
      connection: this.connection,
      relayer: this.relayer,
      executorProgramId: this.programId,
      program: this.program,
      provider,
      dlmm: resolveDlmmProgram(loadConfig().dlmm),
    };
    this.poolBuilder = new DlmmPoolBuilder(ctx);
    this.tokenFactory = new TokenFactory(ctx);
    this.liquidityPlanner = new LiquidityPlanner(ctx);
  }

  setupTestPair(opts: Parameters<DlmmPoolBuilder["setupTestPair"]>[0] = {}) {
    return this.poolBuilder.setupTestPair(opts);
  }

  useExistingPool(args: Parameters<DlmmPoolBuilder["useExistingPool"]>[0]) {
    return this.poolBuilder.useExistingPool(args);
  }

  mintTestTokens(args: Parameters<TokenFactory["mintTestTokens"]>[0]) {
    return this.tokenFactory.mintTestTokens(args);
  }

  buildInitPositionTx(args: Parameters<LiquidityPlanner["buildInitPositionTx"]>[0]) {
    return this.liquidityPlanner.buildInitPositionTx(args);
  }

  buildAddLiquidityTx(args: Parameters<LiquidityPlanner["buildAddLiquidityTx"]>[0]) {
    return this.liquidityPlanner.buildAddLiquidityTx(args);
  }

  buildClaimFeesTx(args: Parameters<LiquidityPlanner["buildClaimFeesTx"]>[0]) {
    return this.liquidityPlanner.buildClaimFeesTx(args);
  }

  buildWithdrawCloseTx(args: Parameters<LiquidityPlanner["buildWithdrawCloseTx"]>[0]) {
    return this.liquidityPlanner.buildWithdrawCloseTx(args);
  }

  /**
   * Build the unsigned `dlmm_swap` tx for the stealth wallet to sign and
   * submit. The server pre-signs as fee payer; stealth signs as the
   * authorized swap user. Used by the browser-driven private-claim and
   * private-exit orchestrators to consolidate non-SOL outputs back to SOL
   * before the mixer deposit.
   *
   * Same-pool reject (swap source == LP target) is enforced upstream in
   * `swap.service.validateSwapIntent`; this builder trusts its inputs.
   */
  async buildDlmmSwapTx(args: BuildSwapTxArgs): Promise<BuildSwapTxResult> {
    return this.swapClient.buildSwapTx(args);
  }

  /**
   * Read the PoolAuthority PDA + best-effort DLMM position state for the
   * pool-detail UI. Returns null when the PDA hasn't been initialised.
   */
  async fetchPositionAuthority(
    stealth: PublicKey,
    lbPair: PublicKey,
  ): Promise<PoolAuthorityView | null> {
    const dlmmCfg = resolveDlmmProgram(loadConfig().dlmm);
    const [pda] = derivePoolAuthorityPda(this.programId, stealth, lbPair);
    const acct = await (this.program.account as any).poolAuthority.fetchNullable(pda);
    if (!acct) return null;
    const dlmm = acct.poolRef?.dlmm;
    if (!dlmm) return null;

    // Best-effort: read the on-chain position to recover the deposit's
    // bin range. Failures are tolerated (returns the base shape) so the
    // endpoint stays useful when DLMM RPCs are flaky.
    let extras: Partial<{
      lowerBinId: number;
      upperBinId: number;
      width: number;
      tokenX: string;
      tokenY: string;
      binArrayLower: string;
      binArrayUpper: string;
      activeBin: number;
      binStep: number;
    }> = {};
    try {
      const dlmmInstance = await DLMM.create(this.connection, lbPair);
      const lbPosition = await dlmmInstance.getPosition(dlmm.position as PublicKey);
      const lowerBinId = lbPosition.positionData.lowerBinId;
      const upperBinId = lbPosition.positionData.upperBinId;
      const lowerArrayIdx = binIdToBinArrayIndex(new BN(lowerBinId));
      const upperArrayIdx = binIdToBinArrayIndex(new BN(upperBinId));
      const [binArrayLower] = deriveBinArray(lbPair, lowerArrayIdx, dlmmCfg.programId);
      const [binArrayUpper] = deriveBinArray(lbPair, upperArrayIdx, dlmmCfg.programId);
      extras = {
        lowerBinId,
        upperBinId,
        width: upperBinId - lowerBinId + 1,
        tokenX: dlmmInstance.lbPair.tokenXMint.toBase58(),
        tokenY: dlmmInstance.lbPair.tokenYMint.toBase58(),
        binArrayLower: binArrayLower.toBase58(),
        binArrayUpper: binArrayUpper.toBase58(),
        activeBin: dlmmInstance.lbPair.activeId,
        binStep: dlmmInstance.lbPair.binStep,
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[fetchPositionAuthority] could not decode DLMM position; returning base shape:",
        err instanceof Error ? err.message : err,
      );
    }

    return {
      pda: pda.toBase58(),
      stealthPubkey: acct.stealthPubkey.toBase58(),
      lbPair: dlmm.lbPair.toBase58(),
      position: dlmm.position.toBase58(),
      positionPubkey: dlmm.position.toBase58(),
      exitRecipient: acct.exitRecipient.toBase58(),
      ...extras,
    };
  }

  /**
   * Read on-chain Meteora DLMM position state for the portfolio UI.
   *
   * Returns raw amounts plus USD-denominated value/fees so the client can
   * render `value`, `feesEarned`, and `claimable` from real chain state
   * instead of relying on the deposit-time snapshot. Prices come from the
   * existing Jupiter price service; decimals from the mint accounts.
   *
   * Returns `null` when the position account doesn't exist (e.g. closed).
   */
  async getPositionState(args: {
    lbPair: PublicKey;
    positionPubkey: PublicKey;
  }): Promise<PositionStateView | null> {
    const dlmm = await DLMM.create(this.connection, args.lbPair);
    let lbPosition;
    try {
      lbPosition = await dlmm.getPosition(args.positionPubkey);
    } catch {
      // Closed or never-existed → treat as gone so the UI can drop it.
      return null;
    }

    const data = lbPosition.positionData;
    const tokenXMint = dlmm.lbPair.tokenXMint;
    const tokenYMint = dlmm.lbPair.tokenYMint;

    const [decimalsX, decimalsY] = await Promise.all([
      getMintDecimals(this.connection, tokenXMint),
      getMintDecimals(this.connection, tokenYMint),
    ]);

    const prices = await getPrices([tokenXMint.toBase58(), tokenYMint.toBase58()]).catch(
      () => ({}) as Awaited<ReturnType<typeof getPrices>>,
    );
    const priceX = prices[tokenXMint.toBase58()]?.usdPrice ?? 0;
    const priceY = prices[tokenYMint.toBase58()]?.usdPrice ?? 0;

    const feeXRaw = BigInt(data.feeX.toString());
    const feeYRaw = BigInt(data.feeY.toString());
    const totalXRaw = BigInt(data.totalXAmount.split(".")[0]); // SDK returns string with optional decimal
    const totalYRaw = BigInt(data.totalYAmount.split(".")[0]);

    const feeUsdX = rawToUsd(feeXRaw, decimalsX, priceX);
    const feeUsdY = rawToUsd(feeYRaw, decimalsY, priceY);
    const valueUsdX = rawToUsd(totalXRaw, decimalsX, priceX);
    const valueUsdY = rawToUsd(totalYRaw, decimalsY, priceY);

    return {
      positionPubkey: args.positionPubkey.toBase58(),
      lbPair: args.lbPair.toBase58(),
      lowerBinId: data.lowerBinId,
      upperBinId: data.upperBinId,
      activeBinId: dlmm.lbPair.activeId,
      tokenXMint: tokenXMint.toBase58(),
      tokenYMint: tokenYMint.toBase58(),
      decimalsX,
      decimalsY,
      feeXLamports: feeXRaw.toString(),
      feeYLamports: feeYRaw.toString(),
      totalXLamports: totalXRaw.toString(),
      totalYLamports: totalYRaw.toString(),
      feeUsd: feeUsdX + feeUsdY,
      valueUsd: valueUsdX + valueUsdY,
      priceXUsd: priceX,
      priceYUsd: priceY,
    };
  }
}

export interface PoolAuthorityView {
  pda: string;
  stealthPubkey: string;
  lbPair: string;
  position: string;
  positionPubkey: string;
  exitRecipient: string;
  /** On-chain DLMM position bin range — populated when the position account
   *  is decodable. The pool detail page uses this so the user doesn't have
   *  to remember the original deposit range to claim or withdraw. */
  lowerBinId?: number;
  upperBinId?: number;
  width?: number;
  /** Pool token mints + bin-array PDAs covering the position. Same shape
   *  as `useExistingPool` returns so the frontend can hand the result
   *  straight to /executor/{claim-fees,withdraw-close}-tx. */
  tokenX?: string;
  tokenY?: string;
  binArrayLower?: string;
  binArrayUpper?: string;
  activeBin?: number;
  binStep?: number;
}

export interface PositionStateView {
  positionPubkey: string;
  lbPair: string;
  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
  tokenXMint: string;
  tokenYMint: string;
  decimalsX: number;
  decimalsY: number;
  feeXLamports: string;
  feeYLamports: string;
  totalXLamports: string;
  totalYLamports: string;
  feeUsd: number;
  valueUsd: number;
  priceXUsd: number;
  priceYUsd: number;
}

async function getMintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  const info = await connection.getAccountInfo(mint);
  if (!info || info.data.length < 45) return 0;
  // SPL Token mint layout: decimals at byte offset 44 (u8).
  return info.data[44];
}

function rawToUsd(raw: bigint, decimals: number, priceUsd: number): number {
  if (raw === 0n || priceUsd === 0) return 0;
  // Lose precision past 1e15 via Number — fine for display USD numbers.
  const divisor = 10 ** decimals;
  return (Number(raw) / divisor) * priceUsd;
}

// Re-export the shape consumers rely on (controller imports it via the
// shape-only `type` keyword).
export type { DistributionShape };
