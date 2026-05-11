import type { PortfolioPosition } from "@/components/octora/types";

/**
 * Overview metrics computed directly from live + closed PortfolioPosition
 * records. No synthetic series, no historical snapshotting — every field here
 * either comes from a localPositions entry (deposit-time depositedUsd, the
 * derivationVersion, timestamps) or from the on-chain state-query join
 * (valueUsd, feeUsd, hasClaimableFees) wired by usePortfolioPositions.
 *
 * Fields we used to fake (win rate, biggest win, avg invested, daily P&L
 * series) were removed in 2026-05 because we don't snapshot position value
 * over time and the rendered numbers had no relationship to anything the
 * user actually did. The Recent Activity panel now uses the real
 * StoredPosition timestamps for the historical view.
 */
export interface OverviewMetrics {
  /** Sum of depositedUsd across live (non-closed) positions. */
  totalDeposited: number;
  /** Sum of valueUsd across live positions, from on-chain state queries. */
  totalPositionValue: number;
  /** Sum of feesUsd across live positions (= "Pending Fees"). */
  pendingFeesUsd: number;
  /** Net P&L = value + fees − deposited, live only. */
  totalPnL: number;
  /** P&L as a percent of deposited; 0 when nothing deposited. */
  totalPnLPct: number;
  /** Count of live positions whose on-chain state reports raw fee lamports
   *  > 0 even though feesUsd may round to $0 on devnet (no Jupiter price). */
  positionsWithClaimableFees: number;
  livePositionCount: number;
  closedPositionCount: number;
  poolCount: number;
}

export function computeOverviewMetrics(positions: PortfolioPosition[]): OverviewMetrics {
  const live = positions.filter((p) => !p.closed);
  const closed = positions.filter((p) => p.closed);

  let totalDeposited = 0;
  let totalPositionValue = 0;
  let pendingFeesUsd = 0;
  let positionsWithClaimableFees = 0;
  const pools = new Set<string>();

  for (const p of live) {
    totalDeposited += p.depositedUsd ?? 0;
    totalPositionValue += p.valueUsd ?? 0;
    pendingFeesUsd += p.feesUsd ?? 0;
    if (p.hasClaimableFees) positionsWithClaimableFees += 1;
    pools.add(p.poolAddress);
  }

  const totalPnL = totalPositionValue + pendingFeesUsd - totalDeposited;
  const totalPnLPct = totalDeposited > 0 ? (totalPnL / totalDeposited) * 100 : 0;

  return {
    totalDeposited,
    totalPositionValue,
    pendingFeesUsd,
    totalPnL,
    totalPnLPct,
    positionsWithClaimableFees,
    livePositionCount: live.length,
    closedPositionCount: closed.length,
    poolCount: pools.size,
  };
}
