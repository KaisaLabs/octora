import type {
  AddLiquidityInput,
  ClaimInput,
  MeteoraExecutionReceipt,
  MeteoraExecutor,
  WithdrawCloseInput,
} from "./meteora-executor";

export class MockMeteoraExecutor implements MeteoraExecutor {
  async addLiquidity(input: AddLiquidityInput): Promise<MeteoraExecutionReceipt> {
    return { signature: buildSignature("add-liquidity", input.podId, input.amountSol) };
  }

  async claim(input: ClaimInput): Promise<MeteoraExecutionReceipt> {
    return { signature: buildSignature("claim", input.podId, input.positionId) };
  }

  async withdrawClose(input: WithdrawCloseInput): Promise<MeteoraExecutionReceipt> {
    return { signature: buildSignature("withdraw-close", input.podId, input.positionId) };
  }
}

export function createMockMeteoraExecutor(): MeteoraExecutor {
  return new MockMeteoraExecutor();
}

function buildSignature(action: string, first: string, second: string) {
  return `mock-meteora-${action}-${first}-${second}`;
}
