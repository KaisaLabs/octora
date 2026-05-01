declare module "circomlibjs" {
  interface PoseidonField {
    e(value: bigint | number | string): unknown;
    toString(value: unknown, radix?: number): string;
  }

  interface PoseidonFunction {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (inputs: any[], state?: unknown, nOut?: number): unknown;
    F: PoseidonField;
  }

  export function buildPoseidon(): Promise<PoseidonFunction>;
}
