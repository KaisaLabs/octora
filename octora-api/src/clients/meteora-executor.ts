export interface MeteoraExecutionReceipt {
  signature: string;
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

export interface MeteoraExecutor {
  addLiquidity(input: AddLiquidityInput): Promise<MeteoraExecutionReceipt>;
  claim(input: ClaimInput): Promise<MeteoraExecutionReceipt>;
  withdrawClose(input: WithdrawCloseInput): Promise<MeteoraExecutionReceipt>;
}
