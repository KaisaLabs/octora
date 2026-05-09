export interface MeteoraExecutionReceipt {
  signature: string;
  /**
   * Optional success flag for executors that distinguish "tx landed" from
   * "tx submitted". Mock and the simple on-chain path don't set it; richer
   * implementations may. Treat absence as success.
   */
  success?: boolean;
}

export interface AddLiquidityInput {
  podId: string;
  amountSol: string;
}

export interface ClaimInput {
  podId: string;
  positionId: string;
}

export interface WithdrawCloseInput {
  podId: string;
  positionId: string;
}

/**
 * Optional execution context. The on-chain executor needs the stealth
 * keypair, LB pair, and DLMM remaining_accounts; the mock ignores it.
 * Typed as `unknown` at the interface boundary so consumers don't have
 * to import the on-chain-specific shape — `OnchainMeteoraExecutor` casts
 * internally and throws if ctx is missing.
 */
export type MeteoraExecutionContext = unknown;

export interface MeteoraExecutor {
  addLiquidity(
    input: AddLiquidityInput,
    ctx?: MeteoraExecutionContext,
  ): Promise<MeteoraExecutionReceipt>;
  claim(
    input: ClaimInput,
    ctx?: MeteoraExecutionContext,
  ): Promise<MeteoraExecutionReceipt>;
  withdrawClose(
    input: WithdrawCloseInput,
    ctx?: MeteoraExecutionContext,
  ): Promise<MeteoraExecutionReceipt>;
}
