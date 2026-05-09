/**
 * Test plan IDs covered:
 *   FE-POS-001 (data layer) PnL series and summary maths used by the position
 *               detail page. Pure functions, no DOM.
 */
import { describe, expect, it } from "vitest";
import { generateDailyPnL, summarizePnL } from "../pnl";

describe("generateDailyPnL", () => {
  it("emits one entry per inclusive day between since and until", () => {
    const since = new Date("2026-01-01T00:00:00");
    const until = new Date("2026-01-07T00:00:00");
    const series = generateDailyPnL({ since, until });
    expect(series).toHaveLength(7);
    expect(series[0].date).toMatch(/^2026-01-01$/);
    expect(series[6].date).toMatch(/^2026-01-07$/);
  });

  it("is deterministic for the same seed", () => {
    const since = new Date("2026-01-01");
    const until = new Date("2026-01-30");
    const a = generateDailyPnL({ since, until, seed: 7 });
    const b = generateDailyPnL({ since, until, seed: 7 });
    expect(a).toEqual(b);
  });

  it("different seeds produce different series", () => {
    const since = new Date("2026-01-01");
    const until = new Date("2026-01-30");
    const a = generateDailyPnL({ since, until, seed: 1 });
    const b = generateDailyPnL({ since, until, seed: 2 });
    expect(a).not.toEqual(b);
  });
});

describe("summarizePnL", () => {
  it("computes total / pct / win rate from a known series", () => {
    const daily = [
      { date: "2026-01-01", pnlUsd: 10, positions: 1 },
      { date: "2026-01-02", pnlUsd: -5, positions: 1 },
      { date: "2026-01-03", pnlUsd: 30, positions: 2 },
      { date: "2026-01-04", pnlUsd: 0, positions: 1 },
    ];

    const summary = summarizePnL(daily, {
      totalDeposited: 1000,
      totalPositionValue: 1100,
      feesClaimed: 5,
      claimableFees: 2,
    });

    expect(summary.totalPnL).toBeCloseTo(35, 6);
    expect(summary.totalPnLPct).toBeCloseTo(3.5, 6);
    // pnlUsd > 0 days: day 1 and day 3. Day 4 (=0) is not a "win".
    expect(summary.winRate).toBeCloseTo(50, 6);
    expect(summary.biggestWinUsd).toBe(30);
    expect(summary.biggestWinPct).toBeCloseTo(3, 6);
  });

  it("FE-POS-001 (boundary): totalDeposited=0 yields safe zero pcts (no NaN/Infinity)", () => {
    const daily = [{ date: "2026-01-01", pnlUsd: 5, positions: 1 }];
    const summary = summarizePnL(daily, {
      totalDeposited: 0,
      totalPositionValue: 0,
      feesClaimed: 0,
      claimableFees: 0,
    });
    expect(summary.totalPnLPct).toBe(0);
    expect(summary.biggestWinPct).toBe(0);
    expect(Number.isFinite(summary.avgInvested)).toBe(true);
  });

  it("empty series produces zero totals and 0% win rate (not NaN)", () => {
    const summary = summarizePnL([], {
      totalDeposited: 100,
      totalPositionValue: 100,
      feesClaimed: 0,
      claimableFees: 0,
    });
    expect(summary.totalPnL).toBe(0);
    expect(summary.winRate).toBe(0);
    expect(summary.biggestWinUsd).toBe(0);
  });
});
