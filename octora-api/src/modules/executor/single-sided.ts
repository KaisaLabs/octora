/**
 * Single-sided SOL liquidity helper.
 *
 * MVP only deposits SOL (Wrapped SOL): the non-SOL `amount` is always 0.
 * The bin range may straddle the active bin — bins on the SOL side of
 * active receive liquidity per the chosen distribution shape, bins on the
 * non-SOL side receive nothing at deposit (their `amount` is the missing
 * non-SOL token which we don't have). Those wrong-side bins capture SOL
 * organically when price later moves into them, which is the standard
 * "both-directions" LP strategy users expect.
 *
 * The on-chain `*ImBalanced` strategy (index 6/7/8) tolerates a zero
 * amount on one side — Meteora distributes only the non-zero side across
 * the corresponding bins. Earlier revisions forced the range strictly
 * to one side of active; the relaxed version below lets the user pick a
 * straddling range, matching how the pool detail UI now lets the active
 * marker sit inside the user's chosen min/max handles.
 */

import { ValidationError } from "#common/errors";

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

export class SingleSidedRangeError extends ValidationError {
  constructor(message: string) {
    super(message, { code: "single_sided_range" });
    this.name = "SingleSidedRangeError";
  }
}

/**
 * Compute the executor's `dlmm_add_liquidity` parameters for a single-sided
 * SOL deposit. The range may straddle the active bin — the non-SOL side
 * receives 0 amount, so wrong-side bins simply hold no liquidity at deposit.
 *
 * Validates the input is sane (positive amount, well-ordered range) but
 * does NOT constrain the range relative to active. Meteora's *ImBalanced
 * strategy distributes only the non-zero amount across the corresponding
 * side of active, leaving the other side empty.
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

  // Range must overlap the SOL side of active by at least one bin —
  // otherwise we'd be sending SOL into a range that has nothing but
  // non-SOL bins, and Meteora would receive 0 deposit. Catch this here
  // with a clear error rather than letting it look like a successful
  // tx that did nothing.
  if (input.solIsTokenX) {
    // SOL = X → SOL bins are >= activeBin. Range needs upper > active to
    // include at least one SOL bin (bins above active receive X).
    if (input.upperBinId < input.activeBinId) {
      throw new SingleSidedRangeError(
        `Single-sided SOL (X side): range [${input.lowerBinId}, ${input.upperBinId}] is entirely below active (${input.activeBinId}); ` +
          "all bins would receive 0 SOL. Move upper above active.",
      );
    }
  } else {
    // SOL = Y → SOL bins are <= activeBin.
    if (input.lowerBinId > input.activeBinId) {
      throw new SingleSidedRangeError(
        `Single-sided SOL (Y side): range [${input.lowerBinId}, ${input.upperBinId}] is entirely above active (${input.activeBinId}); ` +
          "all bins would receive 0 SOL. Move lower below active.",
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
