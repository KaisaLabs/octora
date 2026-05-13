/**
 * Picks a Meteora DLMM pool to swap *through* on the way into a non-SOL LP
 * target. Hard rule: source pool MUST differ from the LP target — swapping
 * on the same pool you're about to LP into front-runs your own entry.
 *
 * Strategy: among all pools containing the target token paired against SOL,
 * pick the one with the deepest liquidity (highest TVL). If none exists,
 * return `null` — the frontend renders "no privacy swap path" and the
 * intent is rejected.
 */

import { listPools, type PoolSummary, type Network } from "#modules/dlmm";
import { ValidationError } from "#common/errors";

/** Solana wrapped-SOL native mint. */
const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

export interface SwapSourceCandidate {
  /** The recommended source pool. */
  pool: PoolSummary;
  /** True when this is the user-supplied target — the resolver returns
   *  candidates so callers can present alternatives in the UI. */
  isTarget: boolean;
}

export interface ResolveSwapSourceInput {
  network: Network;
  /** The user-selected LP target pool (lb_pair address). */
  targetPoolAddress: string;
  /** Mint of the non-SOL token in the target pool. The resolver looks for
   *  pools that pair this mint with SOL. */
  nonSolMint: string;
  /** Minimum acceptable TVL (USD). Below this we'd be swapping into a
   *  market too thin for predictable execution. Default $50k. */
  minTvlUsd?: number;
}

export class NoSwapSourceAvailableError extends ValidationError {
  constructor(public readonly targetPoolAddress: string, public readonly nonSolMint: string) {
    super(
      `No SOL-paired Meteora DLMM pool found for ${nonSolMint} other than the LP target ` +
        `(${targetPoolAddress}). Privacy-preserving swap path unavailable for this pair.`,
      {
        code: "no_swap_source_available",
        details: { targetPoolAddress, nonSolMint },
      },
    );
    this.name = "NoSwapSourceAvailableError";
  }
}

/**
 * Recommend a source pool for the swap leg. Throws
 * {@link NoSwapSourceAvailableError} when no viable candidate exists.
 *
 * Scope: returns *one* pick (the deepest non-target pool). The full
 * candidate list is available via {@link listSwapSourceCandidates} when
 * the UI needs to render an override picker.
 */
export async function recommendSwapSource(input: ResolveSwapSourceInput): Promise<PoolSummary> {
  const candidates = await listSwapSourceCandidates(input);
  const usable = candidates.filter((c) => !c.isTarget);
  if (usable.length === 0) {
    throw new NoSwapSourceAvailableError(input.targetPoolAddress, input.nonSolMint);
  }
  // Already TVL-sorted by listSwapSourceCandidates.
  return usable[0]!.pool;
}

/**
 * Return all SOL-paired Meteora pools containing the non-SOL target mint,
 * sorted by TVL desc, with a flag indicating which is the LP target.
 *
 * Useful for the frontend `SwapSourceSelector` modal where users may want
 * to override the recommended pick.
 */
export async function listSwapSourceCandidates(
  input: ResolveSwapSourceInput,
): Promise<SwapSourceCandidate[]> {
  const minTvlUsd = input.minTvlUsd ?? 50_000;
  // listPools(network, query?). The Meteora indexer doesn't support a
  // "tokens contain X" filter cleanly across mainnet vs devnet shapes, so
  // we pull a generous page and filter client-side. Page size is bounded
  // by the indexer (200 on mainnet, similar on devnet) — for the long-tail
  // memecoin case the relevant pool count is small.
  const page = await listPools(input.network, {
    pageSize: 200,
    sortBy: "tvl",
  });

  return page.data
    .filter((pool) => poolContainsBothMints(pool, input.nonSolMint, NATIVE_SOL_MINT))
    .filter((pool) => pool.tvl >= minTvlUsd || pool.address === input.targetPoolAddress)
    .map((pool) => ({ pool, isTarget: pool.address === input.targetPoolAddress }))
    .sort((a, b) => b.pool.tvl - a.pool.tvl);
}

function poolContainsBothMints(pool: PoolSummary, mintA: string, mintB: string): boolean {
  const x = pool.tokenX.mint;
  const y = pool.tokenY.mint;
  return (x === mintA && y === mintB) || (x === mintB && y === mintA);
}
