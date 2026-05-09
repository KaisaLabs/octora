import type {
  AddLiquidityInput,
  ClaimInput,
  MeteoraExecutionReceipt,
  MeteoraExecutor,
  WithdrawCloseInput,
} from "./meteora-executor.js";
import type { OctoraExecutorClient } from "./octora-executor.client.js";
import type { AccountMeta, Keypair, PublicKey } from "@solana/web3.js";

/**
 * Rich context the on-chain executor needs for each operation.
 * Populated from the position record at call time.
 */
export interface OnchainPositionContext {
  stealthKeypair: Keypair;
  positionKeypair: Keypair;
  lbPair: PublicKey;
  exitRecipient: PublicKey;
  /** DLMM `add_liquidity_by_strategy` remaining_accounts (16 entries) */
  dlmmAddLiquidityAccounts: AccountMeta[];
  /** DLMM `claim_fee` remaining_accounts (14 entries) */
  dlmmClaimAccounts: AccountMeta[];
  /** DLMM remove+close union remaining_accounts (17 entries) */
  dlmmWithdrawCloseAccounts: AccountMeta[];
  /** Borsh-encoded liquidity params for add_liquidity */
  liquidityParams: Buffer;
  lowerBinId: number;
  upperBinId: number;
  positionWidth: number;
}

export class OnchainExecutorNotWiredError extends Error {
  constructor(message = "On-chain Meteora executor is not wired") {
    super(message);
    this.name = "OnchainExecutorNotWiredError";
  }
}

export class OnchainMeteoraExecutor implements MeteoraExecutor {
  constructor(private readonly client: OctoraExecutorClient) {}

  async addLiquidity(
    input: AddLiquidityInput,
    ctx?: unknown,
  ): Promise<MeteoraExecutionReceipt> {
    const c = requireOnchainCtx(ctx, "addLiquidity");
    const ix = await this.client.buildAddLiquidityIx({
      stealth: c.stealthKeypair.publicKey,
      lbPair: c.lbPair,
      dlmmRemainingAccounts: c.dlmmAddLiquidityAccounts,
      liquidityParams: c.liquidityParams,
    });

    const sig = await this.client.sendIx(ix, [
      c.stealthKeypair,
    ], { computeUnits: 1_400_000 });

    return { signature: sig, success: true };
  }

  async claim(
    input: ClaimInput,
    ctx?: unknown,
  ): Promise<MeteoraExecutionReceipt> {
    const c = requireOnchainCtx(ctx, "claim");
    const ix = await this.client.buildClaimFeesIx({
      stealth: c.stealthKeypair.publicKey,
      lbPair: c.lbPair,
      dlmmRemainingAccounts: c.dlmmClaimAccounts,
    });

    const sig = await this.client.sendIx(ix, [
      c.stealthKeypair,
    ], { computeUnits: 600_000 });

    return { signature: sig, success: true };
  }

  async withdrawClose(
    input: WithdrawCloseInput,
    ctx?: unknown,
  ): Promise<MeteoraExecutionReceipt> {
    const c = requireOnchainCtx(ctx, "withdrawClose");
    const ix = await this.client.buildWithdrawCloseIx({
      stealth: c.stealthKeypair.publicKey,
      lbPair: c.lbPair,
      dlmmRemainingAccounts: c.dlmmWithdrawCloseAccounts,
      fromBinId: c.lowerBinId,
      toBinId: c.upperBinId,
      bpsToRemove: 10000, // 100%
    });

    const sig = await this.client.sendIx(ix, [
      c.stealthKeypair,
    ], { computeUnits: 1_400_000 });

    return { signature: sig, success: true };
  }

  get raw(): OctoraExecutorClient {
    return this.client;
  }
}

function requireOnchainCtx(ctx: unknown, op: string): OnchainPositionContext {
  if (!ctx || typeof ctx !== "object") {
    throw new OnchainExecutorNotWiredError(
      `${op} requires OnchainPositionContext (stealthKeypair, lbPair, ...). ` +
        `position.service does not yet thread it through — run with the mock ` +
        `executor (OCTORA_USE_ONCHAIN_EXECUTOR != "true") or wire the ctx in.`,
    );
  }
  return ctx as OnchainPositionContext;
}

export function createOnchainMeteoraExecutor(
  client: OctoraExecutorClient,
): OnchainMeteoraExecutor {
  return new OnchainMeteoraExecutor(client);
}
