/**
 * Swap-layer orchestration (Plan 2).
 *
 * Lives between the position service and the DLMM swap client. The
 * position service hands it a swap intent + position state and asks for
 * the next state transition.
 *
 * Responsibilities:
 *   1. Validate swap intent: source ≠ target pool, source pool exists in
 *      the Meteora indexer, source pool pairs SOL with the target's
 *      non-SOL token, slippage within sane bounds.
 *   2. (Optional) Build the unsigned swap tx via DlmmSwapClient when the
 *      caller supplies wired RPC + relayer. Plan 4 wires this; Plan 2
 *      keeps the seam.
 *   3. Compute slippage-protected min_out from a quote.
 *
 * Does NOT submit transactions itself — submission is the position
 * service's job (it sequences swap → LP and is responsible for state
 * persistence). The swap.service is a *pure* validator + tx-builder so
 * it can be unit-tested without a Solana RPC.
 */

import type { PoolSummary } from "#modules/dlmm";

import {
  listSwapSourceCandidates,
  recommendSwapSource,
  NoSwapSourceAvailableError,
} from "./swap-pool-resolver";
import type { ResolveSwapSourceInput } from "./swap-pool-resolver";

const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";
const MAX_SLIPPAGE_BPS = 2_000; // 20%; UI soft-blocks above 5%, hard-blocks above 20%.

export class SwapValidationError extends Error {
  constructor(public readonly code: SwapValidationErrorCode, message: string) {
    super(message);
    this.name = "SwapValidationError";
  }
}

export type SwapValidationErrorCode =
  | "swap_source_equals_target"
  | "swap_source_unknown"
  | "swap_source_wrong_pair"
  | "swap_min_out_invalid"
  | "swap_disabled"
  | "swap_required_for_non_sol_pair";

export interface ValidateSwapIntentInput {
  /** When false, any swap step is rejected. Wired from
   *  `config.executorSwapEnabled`. */
  swapEnabled: boolean;
  network: ResolveSwapSourceInput["network"];
  /** LP target pool — present in every add-liquidity intent. */
  targetPool: PoolSummary;
  /** Swap step from the intent body (optional). */
  swap: {
    sourcePoolAddress: string;
    minAmountOut: string;
    swapForY: boolean;
  } | null;
}

export interface ValidatedSwapIntent {
  /** Resolved source pool object — used downstream to derive bin arrays. */
  sourcePool: PoolSummary;
  /** bigint min-out parsed from the intent string. */
  minAmountOut: bigint;
  /** Direction flag passed straight to DLMM. */
  swapForY: boolean;
}

/**
 * Validate the swap step against the LP target pool. Returns the resolved
 * source pool object on success; throws {@link SwapValidationError}
 * otherwise.
 *
 * Decision matrix:
 *   - target pool quote = SOL, swap = null   → no swap needed (returns null)
 *   - target pool quote = SOL, swap = present → reject (swap unnecessary)
 *   - target pool quote ≠ SOL, swap = null   → reject (swap required)
 *   - target pool quote ≠ SOL, swap = present
 *       AND source = target                  → reject (same-pool front-run)
 *       AND source pool unknown              → reject
 *       AND source pool ≠ {SOL, target_token} → reject
 *       AND minOut <= 0                      → reject
 *       AND swapEnabled = false              → reject
 *       OK                                    → return resolved source pool
 */
export async function validateSwapIntent(
  input: ValidateSwapIntentInput,
): Promise<ValidatedSwapIntent | null> {
  const targetIsSolQuoted = isSolMint(input.targetPool.tokenY.mint) || isSolMint(input.targetPool.tokenX.mint);

  if (targetIsSolQuoted) {
    if (input.swap) {
      throw new SwapValidationError(
        "swap_required_for_non_sol_pair",
        `Target pool ${input.targetPool.address} pairs against SOL — no swap step is needed. ` +
          `Drop the \`swap\` field from the intent.`,
      );
    }
    return null;
  }

  if (!input.swap) {
    throw new SwapValidationError(
      "swap_required_for_non_sol_pair",
      `Target pool ${input.targetPool.address} does not pair against SOL — a swap step is ` +
        `required. Pick a SOL-paired source pool that contains the target's non-SOL token.`,
    );
  }

  if (!input.swapEnabled) {
    throw new SwapValidationError(
      "swap_disabled",
      `Executor swap layer is disabled (EXECUTOR_SWAP_ENABLED=false). Non-SOL-paired pools ` +
        `are not currently supported.`,
    );
  }

  if (input.swap.sourcePoolAddress === input.targetPool.address) {
    throw new SwapValidationError(
      "swap_source_equals_target",
      `Swap source pool must differ from LP target pool. Swapping on the same pool you LP into ` +
        `front-runs your own entry — pick a different SOL-paired source for ${input.targetPool.address}.`,
    );
  }

  const minOut = parseBigIntOrThrow(input.swap.minAmountOut);
  if (minOut <= 0n) {
    throw new SwapValidationError(
      "swap_min_out_invalid",
      `swap.minAmountOut must be a positive integer (lamports); got "${input.swap.minAmountOut}".`,
    );
  }

  // Resolve source pool from the indexer. The non-SOL mint is whichever
  // side of the target pool is *not* SOL — but we already established
  // that neither side is SOL above, so the target pair is fully
  // non-SOL (e.g. JUP/USDC). In that case we look for a SOL-paired
  // source pool for the input mint determined by `swapForY`.
  //
  // Phase-1 simplification: assume the user is swapping SOL → some
  // target-pool token. The non-SOL mint is whichever target-pool token
  // matches the user's intended LP "in" side. We resolve via the
  // indexer to confirm the source pool exists and pairs SOL+nonSolMint.
  const candidates = await listSwapSourceCandidates({
    network: input.network,
    targetPoolAddress: input.targetPool.address,
    nonSolMint: input.swap.swapForY
      ? input.targetPool.tokenY.mint
      : input.targetPool.tokenX.mint,
  });

  const match = candidates.find((c) => c.pool.address === input.swap!.sourcePoolAddress);
  if (!match) {
    throw new SwapValidationError(
      "swap_source_unknown",
      `Swap source pool ${input.swap.sourcePoolAddress} not found among SOL-paired pools for ` +
        `the target token. Use GET /pools/:address/swap-source to fetch a recommendation.`,
    );
  }

  // Belt-and-braces: confirm the pool pairs SOL with the expected non-SOL
  // mint. The candidate filter already enforces this, but if Meteora's
  // indexer ever changes shape we want a hard fail rather than a silent
  // route through the wrong pool.
  const pairsSol = isSolMint(match.pool.tokenX.mint) || isSolMint(match.pool.tokenY.mint);
  if (!pairsSol) {
    throw new SwapValidationError(
      "swap_source_wrong_pair",
      `Source pool ${match.pool.address} does not pair against SOL. The swap layer only supports ` +
        `SOL-paired source pools — multi-hop is out of scope.`,
    );
  }

  return {
    sourcePool: match.pool,
    minAmountOut: minOut,
    swapForY: input.swap.swapForY,
  };
}

/**
 * Convenience wrapper: when the caller doesn't yet know which source pool
 * to use, return the recommended one. Throws
 * {@link NoSwapSourceAvailableError} if nothing viable exists.
 */
export async function recommendSourceForTarget(
  input: Omit<ResolveSwapSourceInput, "nonSolMint"> & {
    targetPool: PoolSummary;
    /** Same direction-flag the user will end up passing in `swap.swapForY`. */
    swapForY: boolean;
  },
): Promise<PoolSummary> {
  const nonSolMint = input.swapForY
    ? input.targetPool.tokenY.mint
    : input.targetPool.tokenX.mint;
  return recommendSwapSource({
    network: input.network,
    targetPoolAddress: input.targetPool.address,
    nonSolMint,
    minTvlUsd: input.minTvlUsd,
  });
}

/**
 * Compute slippage-protected min_out from a quote.
 *
 * @param expectedOut - quote returned by the DLMM SDK / on-chain simulate
 * @param slippageBps - basis points; 50 = 0.5%, 100 = 1%, 500 = 5%, etc.
 *                     Capped at {@link MAX_SLIPPAGE_BPS}.
 */
export function computeMinAmountOut(expectedOut: bigint, slippageBps: number): bigint {
  if (!Number.isFinite(slippageBps) || slippageBps < 0) {
    throw new SwapValidationError(
      "swap_min_out_invalid",
      `slippageBps must be a non-negative finite number; got ${slippageBps}.`,
    );
  }
  const capped = Math.min(slippageBps, MAX_SLIPPAGE_BPS);
  // min_out = expectedOut * (10000 - bps) / 10000, integer math.
  return (expectedOut * BigInt(10_000 - capped)) / 10_000n;
}

function isSolMint(mint: string): boolean {
  return mint === NATIVE_SOL_MINT;
}

function parseBigIntOrThrow(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    throw new SwapValidationError(
      "swap_min_out_invalid",
      `Could not parse "${s}" as a bigint string.`,
    );
  }
}

export { NoSwapSourceAvailableError };
