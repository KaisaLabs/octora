import type { DistributionShape, LiquidityBin, Pool } from "@/components/octora/types";

/**
 * Until octora-api exposes per-bin liquidity, we synthesize a plausible
 * distribution from pool-summary data so the bin chart renders end-to-end.
 * Swap this for `getPoolBins(address)` when available — the chart only
 * cares about the LiquidityBin[] shape.
 */

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bin step is in basis points (Meteora convention): price(b+1) = price(b) * (1 + step/10_000). */
export function binPrice(activePrice: number, activeBinId: number, binId: number, binStep: number): number {
  const k = 1 + binStep / 10_000;
  return activePrice * Math.pow(k, binId - activeBinId);
}

export interface SyntheticBinsOptions {
  count?: number;
  width?: number;
}

/**
 * Generate a noisy bell-shaped pool liquidity distribution centered on activeBinId.
 * Volatile pools get fatter tails; stable pools get sharper concentration.
 */
export function synthesizeBins(pool: Pool, opts: SyntheticBinsOptions = {}): LiquidityBin[] {
  const count = opts.count ?? 61;
  const half = Math.floor(count / 2);
  const binStep = pool.binStep || 25;
  const activeBinId = pool.activeBinId || 0;
  const activePrice = pool.activePrice > 0 ? pool.activePrice : impliedPriceFromPool(pool);
  const rng = mulberry32(hashSeed(pool.id || pool.address));

  // Wider σ for high-step (volatile/wide) pools; narrower for stable pools.
  const sigma = Math.max(4, Math.min(half * 0.55, half * (binStep > 100 ? 0.6 : 0.35)));
  const tvl = parseUsd(pool.tvl) || 1_000_000;
  const peak = tvl / (sigma * Math.sqrt(2 * Math.PI));

  return Array.from({ length: count }, (_, i) => {
    const offset = i - half;
    const binId = activeBinId + offset;
    const noise = 0.75 + rng() * 0.5;
    const liquidity = peak * Math.exp(-(offset * offset) / (2 * sigma * sigma)) * noise;
    return {
      binId,
      price: binPrice(activePrice, activeBinId, binId, binStep),
      liquidity: Math.max(liquidity, tvl * 0.0005),
    };
  });
}

function parseUsd(v: string | number): number {
  if (typeof v === "number") return v;
  if (!v) return 0;
  const n = parseFloat(String(v).replace(/[$,]/g, ""));
  if (String(v).includes("M")) return n * 1_000_000;
  if (String(v).includes("K")) return n * 1_000;
  return Number.isFinite(n) ? n : 0;
}

function impliedPriceFromPool(pool: Pool): number {
  // Reasonable defaults so the chart stays readable when API doesn't supply price.
  if (pool.tokenB === "USDC" || pool.tokenB === "USDT") {
    if (pool.tokenA === "SOL") return 195;
    if (pool.tokenA === "JUP") return 0.85;
    if (pool.tokenA === "PYTH") return 0.31;
    if (pool.tokenA === "WIF") return 1.95;
    if (pool.tokenA === "BONK") return 0.0000245;
  }
  return 1;
}

/**
 * Project a USD deposit across bins inside [lower, upper] following the chosen shape.
 * Returns liquidity-weight per bin (in USD), normalized to sum to depositUsd.
 */
export function projectUserShape(
  bins: LiquidityBin[],
  lower: number,
  upper: number,
  shape: DistributionShape,
  depositUsd: number,
): number[] {
  const lo = Math.min(lower, upper);
  const hi = Math.max(lower, upper);
  const span = Math.max(1, hi - lo);
  const center = (lo + hi) / 2;

  const weights = bins.map((b) => {
    if (b.binId < lo || b.binId > hi) return 0;
    if (shape === "spot") return 1;
    if (shape === "curve") {
      // Gaussian peaked at center, 95% inside the range.
      const sigma = span / 4;
      const d = b.binId - center;
      return Math.exp(-(d * d) / (2 * sigma * sigma));
    }
    // bid-ask: U-shape, peaks at edges.
    const t = span === 0 ? 0 : (b.binId - center) / (span / 2);
    return 0.2 + 0.8 * t * t;
  });

  const total = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w) => (w / total) * depositUsd);
}
