/**
 * DLMM swap client — builds an unsigned `dlmm_swap` transaction for the
 * stealth wallet to sign and submit.
 *
 * Mirrors the buildAddLiquidityTx pattern in `executor.service.ts`: the
 * server pre-signs as fee payer (via the relayer keypair) and returns
 * a base64 tx that the browser augments with the stealth signature
 * before broadcasting.
 *
 * Same-pool reject is enforced by the swap.service caller; this client
 * trusts its inputs and only fails on wiring errors (unknown pool,
 * unreachable RPC, etc.).
 */

import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  type Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import type { SolanaChain } from "#common/solana/chain";
import type { AccountMeta } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import DLMM, {
  binIdToBinArrayIndex,
  deriveBinArray,
  deriveOracle,
  deriveReserve,
} from "@meteora-ag/dlmm";

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

// Borsh empty `RemainingAccountsInfo { slices: Vec<...> }` — u32 LE length = 0.
const EMPTY_REMAINING_ACCOUNTS_INFO = Buffer.from([0, 0, 0, 0]);
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getDlmmProgram } from "#common/solana/dlmm-program";
import { resolveMintProgram } from "../builders/token-program.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// IDL is shared with the existing on-chain executor client. Copying the
// path keeps a single source of truth for the executor IDL.
const IDL_PATH = join(__dirname, "..", "..", "execution", "clients", "idl", "octora_executor.json");

export interface DlmmSwapClientOptions {
  chain: SolanaChain;
  /** Hot wallet that pays fees and pre-signs the tx. */
  relayerKeypair: Keypair;
  /** Deployed octora-executor program id. */
  executorProgramId: PublicKey;
}

export interface BuildSwapTxArgs {
  /** Stealth wallet that will sign + submit. */
  stealth: PublicKey;
  /** Source pool's lb_pair (NOT the LP target pool). */
  lbPair: PublicKey;
  /** Lamports to pay in. The stealth must hold this amount in
   *  `tokenIn`. */
  amountIn: bigint;
  /** Slippage-protected lower bound on output token (lamports). */
  minAmountOut: bigint;
  /** Direction flag — DLMM-side. */
  swapForY: boolean;
}

export interface BuildSwapTxResult {
  /** Base64-encoded partially-signed tx. Browser adds stealth signature
   *  and submits. */
  transaction: string;
  /** Recommended source / destination ATAs the caller may want to
   *  display. */
  userTokenIn: string;
  userTokenOut: string;
}

export class DlmmSwapClient {
  private chain: SolanaChain;
  private connection: Connection;
  private relayer: Keypair;
  private programId: PublicKey;
  private program: Program;
  private provider: AnchorProvider;

  constructor(opts: DlmmSwapClientOptions) {
    this.chain = opts.chain;
    this.connection = this.chain.rawConnection();
    this.relayer = opts.relayerKeypair;
    this.programId = opts.executorProgramId;
    const wallet = new Wallet(this.relayer);
    this.provider = this.chain.anchorProvider(wallet);
    const idl = JSON.parse(readFileSync(IDL_PATH, "utf-8"));
    this.program = new Program(idl, this.provider);
  }

  /**
   * Build the unsigned `dlmm_swap` tx. Server pre-signs as fee payer; the
   * stealth wallet's signature is the only thing missing.
   *
   * Account layout matches programs/octora-executor/src/instructions/dlmm/swap.rs.
   */
  async buildSwapTx(args: BuildSwapTxArgs): Promise<BuildSwapTxResult> {
    const dlmmCfg = getDlmmProgram();
    const dlmm = await DLMM.create(this.connection, args.lbPair);
    const tokenX = dlmm.lbPair.tokenXMint;
    const tokenY = dlmm.lbPair.tokenYMint;

    const [reserveX] = deriveReserve(tokenX, args.lbPair, dlmmCfg.programId);
    const [reserveY] = deriveReserve(tokenY, args.lbPair, dlmmCfg.programId);
    const [oracle] = deriveOracle(args.lbPair, dlmmCfg.programId);

    // Bin arrays straddling the active bin. DLMM swap consumes whichever
    // bins the price moves through; we pass two arrays around the active
    // bin so a typical swap stays inside this window.
    const activeIdx = binIdToBinArrayIndex(new BN(dlmm.lbPair.activeId));
    const [binArray0] = deriveBinArray(args.lbPair, activeIdx, dlmmCfg.programId);
    const [binArray1] = deriveBinArray(
      args.lbPair,
      activeIdx.add(new BN(args.swapForY ? -1 : 1)),
      dlmmCfg.programId,
    );

    // Resolve token programs per mint (legacy SPL vs Token-2022) and
    // refuse extensions we can't safely route. TransferHook is rejected
    // until Phase C lands the ExtraAccountMetaList expansion.
    const [tokenXInfo, tokenYInfo] = await Promise.all([
      resolveMintProgram(this.chain, tokenX),
      resolveMintProgram(this.chain, tokenY),
    ]);
    for (const [label, info] of [
      ["tokenX", tokenXInfo],
      ["tokenY", tokenYInfo],
    ] as const) {
      if (info.isToken2022 && info.unsupported) {
        throw new Error(
          `Mint ${label} has unsupported Token-2022 extension: ${info.unsupported}. ` +
            `Swap source pool is not compatible with the private flow.`,
        );
      }
      // Token-2022 plain (no hook) works on swap2. Hooked mints still need
      // transfer-hook account expansion (Phase C) before they can route.
      if (info.isToken2022 && info.hasTransferHook) {
        throw new Error(
          `Mint ${label} is Token-2022 with a TransferHook (program ` +
            `${info.hookProgramId?.toBase58() ?? "unknown"}). ` +
            `Transfer-hook account expansion not yet wired into the swap builder. ` +
            `Pick a non-hook pool for now.`,
        );
      }
    }
    const tokenXProgram = tokenXInfo.programId;
    const tokenYProgram = tokenYInfo.programId;

    // User token ATAs — owned by the stealth, mints derived from swap
    // direction. ATA derivation must pass the per-mint token program ID.
    const inputMint = args.swapForY ? tokenX : tokenY;
    const outputMint = args.swapForY ? tokenY : tokenX;
    const inputProgram = args.swapForY ? tokenXProgram : tokenYProgram;
    const outputProgram = args.swapForY ? tokenYProgram : tokenXProgram;
    const userTokenIn = getAssociatedTokenAddressSync(
      inputMint, args.stealth, false, inputProgram,
    );
    const userTokenOut = getAssociatedTokenAddressSync(
      outputMint, args.stealth, false, outputProgram,
    );

    // v2 layout (swap2). Adds memo_program at slot 13 and shifts event/program
    // back by one. Bin arrays move to the tail. Mirrors
    // programs/octora-executor/src/instructions/dlmm/swap.rs.
    const remainingMetas: AccountMeta[] = [
      { pubkey: args.lbPair, isSigner: false, isWritable: true },                // 0 lb_pair
      { pubkey: dlmmCfg.programId, isSigner: false, isWritable: false },         // 1 bitmap_ext sentinel
      { pubkey: reserveX, isSigner: false, isWritable: true },                   // 2 reserve_x
      { pubkey: reserveY, isSigner: false, isWritable: true },                   // 3 reserve_y
      { pubkey: userTokenIn, isSigner: false, isWritable: true },                // 4 user_token_in
      { pubkey: userTokenOut, isSigner: false, isWritable: true },               // 5 user_token_out
      { pubkey: tokenX, isSigner: false, isWritable: false },                    // 6 token_x_mint
      { pubkey: tokenY, isSigner: false, isWritable: false },                    // 7 token_y_mint
      { pubkey: oracle, isSigner: false, isWritable: true },                     // 8 oracle
      { pubkey: dlmmCfg.programId, isSigner: false, isWritable: true },          // 9 host_fee_in sentinel
      { pubkey: args.stealth, isSigner: true, isWritable: true },                // 10 user
      { pubkey: tokenXProgram, isSigner: false, isWritable: false },             // 11 token_x_program
      { pubkey: tokenYProgram, isSigner: false, isWritable: false },             // 12 token_y_program
      { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },           // 13 memo_program
      { pubkey: dlmmCfg.eventAuthority, isSigner: false, isWritable: false },    // 14 event_authority
      { pubkey: dlmmCfg.programId, isSigner: false, isWritable: false },         // 15 dlmm_program
      // tail: transfer-hook accounts + bin arrays.
      { pubkey: binArray0, isSigner: false, isWritable: true },
      { pubkey: binArray1, isSigner: false, isWritable: true },
    ];

    const [configPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      this.programId,
    );

    const ix = await this.program.methods
      .dlmmSwap(
        new BN(args.amountIn.toString()),
        new BN(args.minAmountOut.toString()),
        EMPTY_REMAINING_ACCOUNTS_INFO,
      )
      .accounts({
        stealth: args.stealth,
        dlmmProgram: dlmmCfg.programId,
        lbPair: args.lbPair,
        config: configPDA,
      })
      .remainingAccounts(remainingMetas)
      .instruction();

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
    const { blockhash } = await this.chain.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: this.relayer.publicKey,
    });
    tx.add(computeIx, ix);
    tx.partialSign(this.relayer);

    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return {
      transaction: serialized.toString("base64"),
      userTokenIn: userTokenIn.toBase58(),
      userTokenOut: userTokenOut.toBase58(),
    };
  }
}
