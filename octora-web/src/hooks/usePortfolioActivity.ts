import { useEffect, useMemo, useState } from "react";

import type { Pool, PortfolioActivity } from "@/components/octora/types";
import {
  POSITIONS_CHANGED_EVENT,
  listLocalPositions,
  type StoredPosition,
} from "@/lib/localPositions";

/**
 * Renders the wallet's local position index as Activity rows. Each stored
 * position emits one Deposit row, and a Withdraw row once `closedAt` is set
 * (recorded by `markLocalPositionClosed` after withdraw_close confirms).
 * Claim / rebalance flows will land here once they also persist metadata.
 */
export function usePortfolioActivity(
  walletAddress: string | null | undefined,
  pools: Pool[],
): PortfolioActivity[] {
  // Mirror the portfolio hook so newly recorded deposits appear without a refresh.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(POSITIONS_CHANGED_EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(POSITIONS_CHANGED_EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);

  const stored = useMemo(
    () => listLocalPositions(walletAddress),
    [walletAddress, version],
  );

  const poolByAddress = useMemo(() => {
    const map = new Map<string, Pool>();
    for (const p of pools) map.set(p.address, p);
    return map;
  }, [pools]);

  return useMemo(
    () =>
      stored
        .flatMap((s) => mapStoredToActivity(s, poolByAddress.get(s.poolAddress)))
        .sort((a, b) => {
          const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
          const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
          return tb - ta;
        }),
    [stored, poolByAddress],
  );
}

function mapStoredToActivity(s: StoredPosition, pool: Pool | undefined): PortfolioActivity[] {
  const poolName = pool?.name ?? `${s.poolAddress.slice(0, 6)}…${s.poolAddress.slice(-4)}`;
  const shapeLabel = s.shape === "spot" ? "Spot" : s.shape === "curve" ? "Curve" : "Bid-ask";

  // Prefer the fund (add-liquidity) signature — that's the moment LP capital
  // actually lands on-chain. Fall back through the chain so the row always
  // links somewhere useful when at least one tx succeeded.
  const depositSig =
    s.signatures?.fund ??
    s.signatures?.init ??
    s.signatures?.relayerWithdraw ??
    s.signatures?.mixerDeposit;

  const rows: PortfolioActivity[] = [
    {
      id: `act-deposit-${s.positionId}`,
      action: `Deposit · ${shapeLabel} · single-sided SOL`,
      kind: "deposit",
      poolName,
      value: formatUsd(s.depositedUsd),
      timestamp: new Date(s.ts).toISOString(),
      time: formatRelativeTime(s.ts),
      privacy: "Routed via mixer + relayer",
      txSignature: depositSig,
    },
  ];

  // Withdraw row appears the moment markLocalPositionClosed records the
  // close. closedAt may be missing for legacy entries closed before the
  // metadata was added — fall back to "now" so the row still renders.
  if (s.closed) {
    const closedAt = s.closedAt ?? Date.now();
    rows.push({
      id: `act-withdraw-${s.positionId}`,
      action: "Withdraw · full close · funds at stealth",
      kind: "withdraw",
      poolName,
      // depositedUsd is the closest stable estimate of what came back.
      // Real recovered USD will plug in once we read the post-close balance.
      value: formatUsd(s.depositedUsd),
      timestamp: new Date(closedAt).toISOString(),
      time: formatRelativeTime(closedAt),
      privacy: "Stealth-signed withdraw_close",
      txSignature: s.withdrawSignature,
    });
  }

  return rows;
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatRelativeTime(ts: number): string {
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)}d ago`;
  const months = days / 30;
  if (months < 12) return `${Math.floor(months)}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
