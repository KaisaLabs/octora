import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";

import type { DistributionShape, Pool, PortfolioPosition } from "@/components/octora/types";
import { getPoolBins, NETWORK } from "@/lib/api";
import {
  listLocalPositions,
  POSITIONS_CHANGED_EVENT,
  type StoredPosition,
} from "@/lib/localPositions";

/**
 * Reads the wallet-keyed local position index and joins it with the
 * pool list so the portfolio renders real deposits instead of mocks.
 *
 * What we can fill in truthfully right now:
 *   - id, poolName, protocol, deposited, range, shape, openedAt — local
 *   - apr, binStep, tokens — from the pool list join
 *   - activeBinId / inRange — from the bins query (one fan-out per unique pool)
 *   - value, fees, claimable, pnl — left as $0.00 / "—" until we wire on-chain
 *     reads for stealth-owned positions. Truthful for fresh positions.
 */
export function usePortfolioPositions(
  walletAddress: string | null | undefined,
  pools: Pool[],
): PortfolioPosition[] {
  // Bump on same-tab writes (custom event from add/remove) and cross-tab
  // writes (native storage event). Without this the useMemo below would
  // never re-read after a deposit on the same page.
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

  const uniquePoolAddresses = useMemo(() => {
    const set = new Set<string>();
    for (const s of stored) set.add(s.poolAddress);
    return Array.from(set);
  }, [stored]);

  // Fan out one bins query per unique pool. Shares cache with usePoolBins
  // (same query key shape) so the pool detail page warms it up.
  const binQueries = useQueries({
    queries: uniquePoolAddresses.map((addr) => ({
      queryKey: ["pool-bins", addr, 21],
      queryFn: () => getPoolBins(addr, { network: NETWORK, count: 21 }),
      staleTime: 30_000,
      retry: 1,
    })),
  });

  const activeBinByAddress = useMemo(() => {
    const map = new Map<string, number>();
    uniquePoolAddresses.forEach((addr, i) => {
      const data = binQueries[i]?.data;
      if (data) map.set(addr, data.activeBinId);
    });
    return map;
  }, [uniquePoolAddresses, binQueries]);

  return useMemo(
    () => stored.map((s) => mapStoredToPortfolio(s, poolByAddress.get(s.poolAddress), activeBinByAddress.get(s.poolAddress))),
    [stored, poolByAddress, activeBinByAddress],
  );
}

function mapStoredToPortfolio(
  s: StoredPosition,
  pool: Pool | undefined,
  activeBinId: number | undefined,
): PortfolioPosition {
  const poolName = pool?.name ?? `${s.poolAddress.slice(0, 6)}…${s.poolAddress.slice(-4)}`;
  const protocol = pool?.protocol ?? "Meteora DLMM";
  const apr = pool?.apr ?? "—";
  const binStep = pool?.binStep;
  const depositedFmt = formatUsd(s.depositedUsd);

  // Position is in range when the live active bin sits inside [lower, upper].
  // Undefined while the bins query is in flight or the pool isn't in the list.
  const inRange =
    activeBinId === undefined
      ? undefined
      : activeBinId >= s.lowerBinId && activeBinId <= s.upperBinId;

  return {
    id: s.positionId,
    poolName,
    protocol,
    deposited: depositedFmt,
    // Until we read on-chain stealth-position state, value tracks the deposit.
    // Fees / claimable / pnl are zero for fresh positions, so showing $0.00 is truthful.
    value: depositedFmt,
    feesEarned: "$0.00",
    apr,
    status: inRange === false ? "Out of range" : "Active",
    rangeLowerBin: s.lowerBinId,
    rangeUpperBin: s.upperBinId,
    activeBinId,
    binStep,
    shape: s.shape as DistributionShape,
    inRange,
    claimable: "$0.00",
    pnl: "$0.00",
    pnlDirection: "flat",
    openedAt: formatRelativeTime(s.ts),
  };
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  // Full-digit format ($1,234.56 / $92,000) — matches the parseUsd used by
  // PortfolioPage which strips letters but doesn't handle K/M suffixes.
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
