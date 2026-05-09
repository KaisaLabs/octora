/**
 * Single-sided SOL liquidity helper.
 *
 * MVP only supports single-sided SOL deposits: the chosen bin range sits
 * entirely on one side of the active bin, and only SOL (Wrapped SOL) is
 * deposited. Which side depends on whether SOL is `tokenX` or `tokenY` in
 * the DLMM pair (DLMM lex-orders mints, so the SOL side is fixed per pool):
 *
 *   - SOL = tokenY → range must satisfy upperBinId <  activeBinId (bid side)
 *   - SOL = tokenX → range must satisfy lowerBinId >  activeBinId (ask side)
 *
 * The non-SOL amount is forced to 0; the on-chain strategy expansion will
 * place the entire SOL amount across the chosen bins per the selected shape.
 */

export type DistributionShape = "spot" | "curve" | "bid-ask";

/**
 * Borsh enum discriminants on the DLMM `LiquidityParameterByStrategy.strategyType`.
 * Index order on-chain:
 *   0 spotBalanced   1 curveBalanced   2 bidAskBalanced
 *   3 spotOneSide    4 curveOneSide    5 bidAskOneSide
 *   6 spotImBalanced 7 curveImBalanced 8 bidAskImBalanced
 *
 * For single-sided deposits the Meteora SDK uses the *ImBalanced family
 * (one amount = 0, the other carries the whole deposit). Verified against
 * tests/octora-executor-happy-path.ts which uses `strategyType: 6` for the
 * working spot single-sided case.
 */
export const STRATEGY_BY_SHAPE: Record<DistributionShape, number> = {
  spot: 6,
  curve: 7,
  "bid-ask": 8,
};

export interface SingleSidedSolPlan {
  /** Token-X amount in lamports (raw u64). Zero when SOL = tokenY. */
  amountX: bigint;
  /** Token-Y amount in lamports (raw u64). Zero when SOL = tokenX. */
  amountY: bigint;
  /** Borsh strategyType discriminant — see STRATEGY_BY_SHAPE. */
  strategyType: number;
  /** Inclusive lower bin id of the deposit range. */
  minBinId: number;
  /** Inclusive upper bin id of the deposit range. */
  maxBinId: number;
}

export interface SingleSidedSolInput {
  /** Total SOL deposit in lamports. Must equal the mixer denomination. */
  totalLamports: bigint;
  /** Pool's current active bin. */
  activeBinId: number;
  /** Inclusive lower bin id of the chosen range. */
  lowerBinId: number;
  /** Inclusive upper bin id of the chosen range. */
  upperBinId: number;
  /** Distribution shape selected in the deposit form. */
  shape: DistributionShape;
  /** True when the SOL mint is the lex-smaller (tokenX) side of the pool. */
  solIsTokenX: boolean;
}

export class SingleSidedRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SingleSidedRangeError";
  }
}

/**
 * Compute the executor's `dlmm_add_liquidity` parameters for a single-sided
 * SOL deposit. Validates the chosen range sits entirely on the SOL side of
 * the active bin and rejects with a clear error otherwise.
 *
 * The validation is intentionally strict — DLMM will silently accept a
 * straddling range and split the deposit across both sides, which would
 * leak the non-SOL token amount the user never agreed to provide.
 */
export function planSingleSidedSol(input: SingleSidedSolInput): SingleSidedSolPlan {
  if (input.totalLamports <= 0n) {
    throw new SingleSidedRangeError("totalLamports must be positive.");
  }
  if (input.lowerBinId > input.upperBinId) {
    throw new SingleSidedRangeError(
      `lowerBinId (${input.lowerBinId}) must be <= upperBinId (${input.upperBinId}).`,
    );
  }

  if (input.solIsTokenX) {
    // SOL = X → ask side, strictly above active.
    if (input.lowerBinId <= input.activeBinId) {
      throw new SingleSidedRangeError(
        `Single-sided SOL (X side): lowerBinId (${input.lowerBinId}) must be > activeBinId (${input.activeBinId}).`,
      );
    }
  } else {
    // SOL = Y → bid side, strictly below active.
    if (input.upperBinId >= input.activeBinId) {
      throw new SingleSidedRangeError(
        `Single-sided SOL (Y side): upperBinId (${input.upperBinId}) must be < activeBinId (${input.activeBinId}).`,
      );
    }
  }

  return {
    amountX: input.solIsTokenX ? input.totalLamports : 0n,
    amountY: input.solIsTokenX ? 0n : input.totalLamports,
    strategyType: STRATEGY_BY_SHAPE[input.shape],
    minBinId: input.lowerBinId,
    maxBinId: input.upperBinId,
  };
}

/**
 * Encode `LiquidityParameterByStrategy` as the on-chain DLMM IDL specifies.
 * Layout (97 bytes):
 *   amountX  : u64 LE
 *   amountY  : u64 LE
 *   activeId : i32 LE
 *   maxActiveBinSlippage : i32 LE
 *   minBinId : i32 LE
 *   maxBinId : i32 LE
 *   strategyType : u8
 *   parameteres : [u8; 64] zero
 */
export function encodeLiquidityParamsByStrategy(p: {
  amountX: bigint;
  amountY: bigint;
  activeId: number;
  maxActiveBinSlippage: number;
  minBinId: number;
  maxBinId: number;
  strategyType: number;
}): Buffer {
  const buf = Buffer.alloc(97);
  let o = 0;
  buf.writeBigUInt64LE(p.amountX, o); o += 8;
  buf.writeBigUInt64LE(p.amountY, o); o += 8;
  buf.writeInt32LE(p.activeId, o); o += 4;
  buf.writeInt32LE(p.maxActiveBinSlippage, o); o += 4;
  buf.writeInt32LE(p.minBinId, o); o += 4;
  buf.writeInt32LE(p.maxBinId, o); o += 4;
  buf.writeUInt8(p.strategyType, o);
  return buf;
}
