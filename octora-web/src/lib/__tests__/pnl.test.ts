/**
 * Test plan IDs covered:
 *   FE-POS-001 (data layer) Overview metrics computed from real positions.
 *               Pure function over PortfolioPosition[], no DOM.
 */
import { describe, expect, it } from "vitest";

import type { PortfolioPosition } from "@/components/octora/types";
import { computeOverviewMetrics } from "../pnl";

function pos(overrides: Partial<PortfolioPosition>): PortfolioPosition {
  return {
    id: overrides.id ?? "pos_test",
    poolAddress: overrides.poolAddress ?? "PoolA",
    poolName: "TROLL/SOL",
    protocol: "Meteora DLMM",
    deposited: "$0.00",
    value: "$0.00",
    feesEarned: "$0.00",
    apr: "—",
    status: "Active",
    ...overrides,
  };
}

describe("computeOverviewMetrics", () => {
  it("sums deposits/value/fees across live positions only", () => {
    const metrics = computeOverviewMetrics([
      pos({ id: "a", poolAddress: "P1", depositedUsd: 1000, valueUsd: 1100, feesUsd: 25 }),
      pos({ id: "b", poolAddress: "P1", depositedUsd: 500, valueUsd: 480, feesUsd: 10 }),
      pos({ id: "c", poolAddress: "P2", depositedUsd: 200, valueUsd: 0, feesUsd: 0, closed: true }),
    ]);
    expect(metrics.totalDeposited).toBe(1500);
    expect(metrics.totalPositionValue).toBe(1580);
    expect(metrics.pendingFeesUsd).toBe(35);
    expect(metrics.livePositionCount).toBe(2);
    expect(metrics.closedPositionCount).toBe(1);
    expect(metrics.poolCount).toBe(1); // both live positions share P1
  });

  it("derives P&L as value + fees − deposited", () => {
    const metrics = computeOverviewMetrics([
      pos({ depositedUsd: 1000, valueUsd: 1100, feesUsd: 25 }),
    ]);
    expect(metrics.totalPnL).toBeCloseTo(125, 6);
    expect(metrics.totalPnLPct).toBeCloseTo(12.5, 6);
  });

  it("counts positions with claimable fees even when USD rounds to 0", () => {
    const metrics = computeOverviewMetrics([
      pos({ depositedUsd: 100, valueUsd: 100, feesUsd: 0, hasClaimableFees: true }),
      pos({ depositedUsd: 100, valueUsd: 100, feesUsd: 0 }),
    ]);
    expect(metrics.pendingFeesUsd).toBe(0);
    expect(metrics.positionsWithClaimableFees).toBe(1);
  });

  it("returns zero P&L percent when nothing deposited (not NaN)", () => {
    const metrics = computeOverviewMetrics([]);
    expect(metrics.totalDeposited).toBe(0);
    expect(metrics.totalPnL).toBe(0);
    expect(metrics.totalPnLPct).toBe(0);
    expect(metrics.livePositionCount).toBe(0);
    expect(metrics.poolCount).toBe(0);
  });
});
