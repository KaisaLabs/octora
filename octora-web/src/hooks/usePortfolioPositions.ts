import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";

import type { DistributionShape, Pool, PortfolioPosition } from "@/components/octora/types";
import { getPoolBins, getPositionState, NETWORK, type PositionStateView } from "@/lib/api";
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

  // Fan out one on-chain position-state query per stored position. This is
  // what gives us real `value`, `feesEarned`, and `claimable` numbers
  // instead of the deposit-time snapshot. 15s stale time so the portfolio
  // refreshes at a reasonable cadence without hammering the RPC.
  const stateQueries = useQueries({
    queries: stored.map((s) => ({
      queryKey: ["position-state", s.poolAddress, s.positionPubkey],
      queryFn: () =>
        getPositionState({
          lbPair: s.poolAddress,
          positionPubkey: s.positionPubkey,
        }),
      staleTime: 15_000,
      refetchInterval: 30_000,
      retry: 1,
    })),
  });

  return useMemo(
    () =>
      stored.map((s, i) =>
        mapStoredToPortfolio(
          s,
          poolByAddress.get(s.poolAddress),
          activeBinByAddress.get(s.poolAddress),
          stateQueries[i]?.data ?? null,
        ),
      ),
    [stored, poolByAddress, activeBinByAddress, stateQueries],
  );
}

function mapStoredToPortfolio(
  s: StoredPosition,
  pool: Pool | undefined,
  binsActiveBinId: number | undefined,
  state: PositionStateView | null,
): PortfolioPosition {
  const poolName = pool?.name ?? `${s.poolAddress.slice(0, 6)}…${s.poolAddress.slice(-4)}`;
  const protocol = pool?.protocol ?? "Meteora DLMM";
  const apr = pool?.apr ?? "—";
  const binStep = pool?.binStep;
  const depositedFmt = formatUsd(s.depositedUsd);

  // Prefer on-chain reads when available — the stored snapshot decays
  // the moment any swap or fee accrual lands on the position.
  const lowerBinId = state?.lowerBinId ?? s.lowerBinId;
  const upperBinId = state?.upperBinId ?? s.upperBinId;
  const activeBinId = state?.activeBinId ?? binsActiveBinId;

  const inRange =
    activeBinId === undefined
      ? undefined
      : activeBinId >= lowerBinId && activeBinId <= upperBinId;

  // Value/fees come from chain when the state query has resolved.
  // Pre-resolve we fall back to the deposit snapshot for value (so the
  // card isn't blank) and $0.00 for fees (truthful for fresh positions).
  // After close: position no longer exists on-chain, so everything zeros out
  // and the user is funnelled toward the Sweep flow.
  const closed = s.closed === true;
  const valueFmt = closed ? "$0.00" : state ? formatUsd(state.valueUsd) : depositedFmt;
  const feesFmt = closed ? "$0.00" : state ? formatUsd(state.feeUsd) : "$0.00";
  // Raw-lamports gate: enables Claim even when Jupiter has no devnet prices
  // and `feeUsd` rounds to $0.
  const hasClaimableFees = !closed && !!state && (
    safeBigInt(state.feeXLamports) > 0n || safeBigInt(state.feeYLamports) > 0n
  );
  const pnlAmount = state ? state.valueUsd + state.feeUsd - s.depositedUsd : 0;
  const pnlDirection: PortfolioPosition["pnlDirection"] =
    pnlAmount > 0.005 ? "up" : pnlAmount < -0.005 ? "down" : "flat";

  const status = closed
    ? "Closed · awaiting sweep"
    : inRange === false
      ? "Out of range"
      : "Active";

  return {
    id: s.positionId,
    poolAddress: s.poolAddress,
    stealthPubkey: s.stealthPubkey,
    derivationVersion: s.derivationVersion,
    closed,
    poolName,
    protocol,
    deposited: depositedFmt,
    value: valueFmt,
    feesEarned: feesFmt,
    depositedUsd: s.depositedUsd,
    valueUsd: closed ? 0 : state?.valueUsd ?? s.depositedUsd,
    feesUsd: closed ? 0 : state?.feeUsd ?? 0,
    apr,
    status,
    rangeLowerBin: lowerBinId,
    rangeUpperBin: upperBinId,
    activeBinId,
    binStep,
    shape: s.shape as DistributionShape,
    inRange: closed ? undefined : inRange,
    claimable: feesFmt,
    hasClaimableFees,
    pnl: closed ? "$0.00" : state ? formatUsdSigned(pnlAmount) : "$0.00",
    pnlDirection,
    openedAt: formatRelativeTime(s.ts),
  };
}

function safeBigInt(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
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

function formatUsdSigned(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  return `${sign}${formatUsd(Math.abs(n))}`;
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
