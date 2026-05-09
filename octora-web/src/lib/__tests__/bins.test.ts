/**
 * Test plan IDs covered:
 *   FE-POOL-004 zero-TVL / zero-liquidity pool — chart never divides by zero,
 *               renders an empty-but-finite distribution
 *   FE-DEP-005 (boundary) projectUserShape preserves total deposit across shapes
 *
 * `bins.ts` is pure synthesis logic (no DOM, no wallet). Unit-test it
 * directly so a regression to the chart math doesn't first surface as a
 * Playwright fail.
 */
import { describe, expect, it } from "vitest";
import { binPrice, projectUserShape, synthesizeBins } from "../bins";
import type { LiquidityBin, Pool } from "@/components/octora/types";

const BASE_POOL: Pool = {
  id: "p1",
  name: "SOL/USDC",
  pair: "SOL-USDC",
  tokenA: "SOL",
  tokenB: "USDC",
  tokenAMint: "So11111111111111111111111111111111111111112",
  tokenBMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  address: "Pool1",
  protocol: "Meteora DLMM",
  tvl: "$1.0M",
  apr: "12.0%",
  volume24h: "$100K",
  fees24h: "$1K",
  strategy: "auto",
  depth: "Tight",
  risk: "Balanced",
  feeBps: 25,
  binStep: 25,
  createdAt: 0,
  binRange: "±25 bins",
  priceRange: "Live",
  activeBinId: 0,
  activePrice: 100,
  allocation: { tokenA: 50, tokenB: 50 },
  tags: [],
};

describe("binPrice", () => {
  it("returns the active price at the active bin", () => {
    expect(binPrice(100, 0, 0, 25)).toBeCloseTo(100, 6);
  });

  it("compounds (1 + step/10000) per bin away from active", () => {
    const k = 1 + 25 / 10_000;
    expect(binPrice(100, 0, 5, 25)).toBeCloseTo(100 * Math.pow(k, 5), 6);
    expect(binPrice(100, 0, -5, 25)).toBeCloseTo(100 * Math.pow(k, -5), 6);
  });
});

describe("synthesizeBins", () => {
  it("returns the requested number of bins centered on activeBinId", () => {
    const bins = synthesizeBins(BASE_POOL, { count: 21 });
    expect(bins).toHaveLength(21);
    const ids = bins.map((b) => b.binId);
    expect(ids[0]).toBe(BASE_POOL.activeBinId - 10);
    expect(ids[ids.length - 1]).toBe(BASE_POOL.activeBinId + 10);
  });

  it("is deterministic per pool — same pool id gives the same liquidity vector", () => {
    const a = synthesizeBins(BASE_POOL, { count: 11 });
    const b = synthesizeBins(BASE_POOL, { count: 11 });
    expect(a.map((x) => x.liquidity)).toEqual(b.map((x) => x.liquidity));
  });

  it("FE-POOL-004: zero-TVL pool still produces finite, non-NaN liquidity values", () => {
    const empty: Pool = { ...BASE_POOL, tvl: "$0", activePrice: 0 };
    const bins = synthesizeBins(empty, { count: 7 });
    expect(bins).toHaveLength(7);
    for (const b of bins) {
      expect(Number.isFinite(b.liquidity)).toBe(true);
      expect(Number.isFinite(b.price)).toBe(true);
      expect(b.liquidity).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("projectUserShape", () => {
  const bins: LiquidityBin[] = Array.from({ length: 11 }, (_, i) => ({
    binId: i - 5,
    price: 100,
    liquidity: 1,
  }));

  it("FE-DEP-005: spot shape distributes the deposit evenly across bins in range", () => {
    const out = projectUserShape(bins, -2, 2, "spot", 1000);
    const inRange = out.filter((v) => v > 0);
    expect(inRange).toHaveLength(5);
    for (const v of inRange) expect(v).toBeCloseTo(200, 6); // 1000 / 5
    // Outside the range is exactly zero.
    const outOfRange = out.filter((v) => v === 0);
    expect(outOfRange).toHaveLength(bins.length - 5);
  });

  it("FE-DEP-005: any shape preserves the total deposit (sum invariant)", () => {
    const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(sumOf(projectUserShape(bins, -2, 2, "spot", 1000))).toBeCloseTo(1000, 6);
    expect(sumOf(projectUserShape(bins, -2, 2, "curve", 1000))).toBeCloseTo(1000, 6);
    expect(sumOf(projectUserShape(bins, -2, 2, "bid-ask", 1000))).toBeCloseTo(1000, 6);
  });

  it("normalises swapped lower/upper bounds (lower > upper still works)", () => {
    const a = projectUserShape(bins, -2, 2, "spot", 100);
    const b = projectUserShape(bins, 2, -2, "spot", 100);
    expect(a).toEqual(b);
  });

  it("curve shape is non-negative and peaks at the centre", () => {
    const out = projectUserShape(bins, -4, 4, "curve", 1);
    const center = out[5]; // binId 0
    for (const v of out) expect(v).toBeGreaterThanOrEqual(0);
    expect(center).toBeGreaterThanOrEqual(out[0]);
    expect(center).toBeGreaterThanOrEqual(out[out.length - 1]);
  });

  it("bid-ask shape peaks at edges, not centre (U-shape)", () => {
    const out = projectUserShape(bins, -4, 4, "bid-ask", 1);
    const center = out[5];
    const edge = Math.max(out[1], out[9]); // just inside the range
    expect(edge).toBeGreaterThan(center);
  });
});
