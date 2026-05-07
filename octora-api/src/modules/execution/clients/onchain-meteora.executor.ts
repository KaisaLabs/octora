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
    ctx: OnchainPositionContext,
  ): Promise<MeteoraExecutionReceipt> {
    const ix = await this.client.buildAddLiquidityIx({
      stealth: ctx.stealthKeypair.publicKey,
      lbPair: ctx.lbPair,
      dlmmRemainingAccounts: ctx.dlmmAddLiquidityAccounts,
      liquidityParams: ctx.liquidityParams,
    });

    const sig = await this.client.sendIx(ix, [
      ctx.stealthKeypair,
    ], { computeUnits: 1_400_000 });

    return { signature: sig, success: true };
  }

  async claim(
    input: ClaimInput,
    ctx: OnchainPositionContext,
  ): Promise<MeteoraExecutionReceipt> {
    const ix = await this.client.buildClaimFeesIx({
      stealth: ctx.stealthKeypair.publicKey,
      lbPair: ctx.lbPair,
      dlmmRemainingAccounts: ctx.dlmmClaimAccounts,
    });

    const sig = await this.client.sendIx(ix, [
      ctx.stealthKeypair,
    ], { computeUnits: 600_000 });

    return { signature: sig, success: true };
  }

  async withdrawClose(
    input: WithdrawCloseInput,
    ctx: OnchainPositionContext,
  ): Promise<MeteoraExecutionReceipt> {
    const ix = await this.client.buildWithdrawCloseIx({
      stealth: ctx.stealthKeypair.publicKey,
      lbPair: ctx.lbPair,
      dlmmRemainingAccounts: ctx.dlmmWithdrawCloseAccounts,
      fromBinId: ctx.lowerBinId,
      toBinId: ctx.upperBinId,
      bpsToRemove: 10000, // 100%
    });

    const sig = await this.client.sendIx(ix, [
      ctx.stealthKeypair,
    ], { computeUnits: 1_400_000 });

    return { signature: sig, success: true };
  }

  get raw(): OctoraExecutorClient {
    return this.client;
  }
}

export function createOnchainMeteoraExecutor(
  client: OctoraExecutorClient,
): OnchainMeteoraExecutor {
  return new OnchainMeteoraExecutor(client);
}
