import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Anchor, ChevronDown, Flame, Loader2, Search, SlidersHorizontal, TrendingUp, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { Pool } from "@/components/octora/types";
import { listPools, mapPoolSummary, NETWORK } from "@/lib/api";
import { DEFAULT_CLUSTER } from "@/lib/solana/config";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { PoolPairPrice } from "@/components/octora/PoolPairPrice";
import { PairAvatar } from "@/components/octora/PairAvatar";
import { usePrices } from "@/hooks/usePrices";
import { useTokenIcons } from "@/hooks/useTokenIcons";

type ContentTab = "top" | "trending" | "stable";
// Meteora's `/pools` indexer only exposes 30m+; no 5m bucket exists upstream,
// so we don't list it here.
type TimeFrame = "30m" | "1h" | "2h" | "4h" | "12h" | "24h";
type SortKey = "tvl" | "volume" | "fees" | "feeTvl" | "apr" | "age";
type SortDir = "asc" | "desc";
interface SortState {
  key: SortKey;
  dir: SortDir;
}

const CONTENT_TABS: Array<{ id: ContentTab; label: string; sub: string; icon: LucideIcon }> = [
  { id: "top", label: "Top Performers", sub: "Best fee yield per dollar at risk", icon: Flame },
  { id: "trending", label: "Trending", sub: "Most 24h volume", icon: TrendingUp },
  { id: "stable", label: "Stable", sub: "USDC / USDT pairs", icon: Anchor },
];

const TIMEFRAMES: TimeFrame[] = ["30m", "1h", "2h", "4h", "12h", "24h"];

interface NumRange {
  min: string;
  max: string;
}
const EMPTY_RANGE: NumRange = { min: "", max: "" };

interface FilterState {
  poolAgeHours: NumRange;
  volume: NumRange;
  fees: NumRange;
  feeTvlPct: NumRange;
  tvl: NumRange;
  binStep: NumRange;
  hideLowTvl: boolean;
}

// On devnet most pools sit well below $1K TVL, so the "Hide low TVL" guard
// would empty the table by default. Disable it there; mainnet still gets the
// spam-filter on by default.
const DEFAULT_FILTERS: FilterState = {
  poolAgeHours: { ...EMPTY_RANGE },
  volume: { ...EMPTY_RANGE },
  fees: { ...EMPTY_RANGE },
  feeTvlPct: { ...EMPTY_RANGE },
  tvl: { ...EMPTY_RANGE },
  binStep: { ...EMPTY_RANGE },
  hideLowTvl: DEFAULT_CLUSTER === "mainnet",
};

function rangeNum(s: string): number | null {
  if (!s.trim()) return null;
  const n = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function inRange(value: number, range: NumRange): boolean {
  const min = rangeNum(range.min);
  const max = rangeNum(range.max);
  if (min !== null && value < min) return false;
  if (max !== null && value > max) return false;
  return true;
}

function countActiveFilters(f: FilterState): number {
  let c = 0;
  for (const k of ["poolAgeHours", "volume", "fees", "feeTvlPct", "tvl", "binStep"] as const) {
    if (f[k].min || f[k].max) c++;
  }
  if (f.hideLowTvl !== DEFAULT_FILTERS.hideLowTvl) c++;
  return c;
}
const parseUsd = (v: string | number) => {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return 0;
  const n = parseFloat(v.replace(/[$,]/g, ""));
  if (v.includes("M")) return n * 1_000_000;
  if (v.includes("K")) return n * 1_000;
  return n;
};
const parsePct = (v: string | number) => {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return 0;
  return parseFloat(v.replace("%", ""));
};

/** Hours represented by each timeframe label. Used to annualize fee/TVL from
 *  whichever bucket the user selected. */
const TF_HOURS: Record<TimeFrame, number> = {
  "30m": 0.5,
  "1h": 1,
  "2h": 2,
  "4h": 4,
  "12h": 12,
  "24h": 24,
};

function tfLabel(tf: TimeFrame): string {
  return tf.replace("h", "H");
}

function volumeAtTf(p: Pool, tf: TimeFrame): number {
  return p.volumeByTf?.[tf] ?? 0;
}

function feesAtTf(p: Pool, tf: TimeFrame): number {
  return p.feesByTf?.[tf] ?? 0;
}

/** Annualized fee yield against TVL, scaled from the selected timeframe.
 *  (fees in window) * (periods per year) / TVL → percent. */
function feeTvlPct(p: Pool, tf: TimeFrame): number {
  const tvl = parseUsd(p.tvl);
  if (tvl <= 0) return 0;
  const fees = feesAtTf(p, tf);
  const periodsPerYear = (365 * 24) / TF_HOURS[tf];
  return ((fees * periodsPerYear) / tvl) * 100;
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

function truncateMiddle(s: string, head = 6, tail = 6): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function fmtFeeTvl(p: Pool, tf: TimeFrame): string {
  const v = feeTvlPct(p, tf);
  if (!Number.isFinite(v) || v === 0) return "—";
  if (v >= 1000) return `${(v / 1000).toFixed(1)}Kx`;
  return `${v.toFixed(1)}%`;
}

interface PoolsPageProps {
  pools: Pool[];
  loading: boolean;
  error: string | null;
}

export function PoolsPage({ pools, loading, error }: PoolsPageProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [contentTab, setContentTab] = useState<ContentTab>("top");
  const [timeframe, setTimeframe] = useState<TimeFrame>("4h");
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  // null = use the implicit content-tab sort. Three-state cycle on click:
  // desc → asc → null.
  const [sort, setSort] = useState<SortState | null>(null);

  const toggleSort = (key: SortKey) => {
    setSort((cur) => {
      if (!cur || cur.key !== key) return { key, dir: "desc" };
      if (cur.dir === "desc") return { key, dir: "asc" };
      return null;
    });
  };

  // Debounce search input to avoid hammering the API on every keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const trimmed = query.trim();
    const t = setTimeout(() => setDebouncedQuery(trimmed), 250);
    return () => clearTimeout(t);
  }, [query]);

  // The local `pools` prop is capped at 50; for any non-empty query we hit the
  // backend so users can find pools by mint/address/pair beyond that window.
  const searchQuery = useQuery({
    queryKey: ["pools", "search", debouncedQuery],
    queryFn: () =>
      listPools({ network: NETWORK, search: debouncedQuery, pageSize: 50 }).then((s) =>
        s.map(mapPoolSummary),
      ),
    enabled: debouncedQuery.length > 0,
    staleTime: 30_000,
  });

  const filterCount = countActiveFilters(filters);

  const openPool = (pool: Pool) => {
    navigate(`/pool/${pool.address}`);
  };

  const nowSec = useMemo(() => Math.floor(Date.now() / 1000), []);

  // A timeframe is "available" if at least one pool in the unfiltered source
  // exposes that bucket. On devnet only "24h" is populated; on mainnet
  // Meteora's indexer covers the full set. Buttons with no backing data are
  // disabled so the selector never silently picks an empty column.
  const availableTfs = useMemo(() => {
    const set = new Set<TimeFrame>(["24h"]);
    for (const p of pools) {
      const keys = Object.keys(p.volumeByTf ?? {}).concat(Object.keys(p.feesByTf ?? {}));
      for (const k of keys) {
        if ((TIMEFRAMES as readonly string[]).includes(k)) set.add(k as TimeFrame);
      }
    }
    return set;
  }, [pools]);

  // If the active timeframe has no data on this network (e.g. user lands on
  // devnet with default "4h"), snap back to 24h so the table isn't empty.
  useEffect(() => {
    if (!availableTfs.has(timeframe)) setTimeframe("24h");
  }, [availableTfs, timeframe]);

  const filteredPools = useMemo(() => {
    const q = debouncedQuery.toLowerCase();
    // While a query is active, prefer the backend search results (covers pools
    // outside the local first-50 window). Fall back to local pools while the
    // request is in flight or if it errors.
    const sourcePools = q && searchQuery.data ? searchQuery.data : pools;

    let list = sourcePools.filter((p) => {
      if (filters.hideLowTvl && parseUsd(p.tvl) < 1_000) return false;
      if (!inRange(p.binStep, filters.binStep)) return false;
      if (!inRange(parseUsd(p.tvl), filters.tvl)) return false;
      if (!inRange(volumeAtTf(p, timeframe), filters.volume)) return false;
      if (!inRange(feesAtTf(p, timeframe), filters.fees)) return false;
      if (!inRange(feeTvlPct(p, timeframe), filters.feeTvlPct)) return false;
      if (filters.poolAgeHours.min || filters.poolAgeHours.max) {
        if (!p.createdAt) return false;
        const ageHours = (nowSec - p.createdAt) / 3600;
        if (!inRange(ageHours, filters.poolAgeHours)) return false;
      }
      if (contentTab === "stable") {
        const upper = [p.tokenA, p.tokenB].map((t) => t.toUpperCase());
        if (!upper.some((t) => t === "USDC" || t === "USDT")) return false;
      }
      if (!q) return true;
      return [
        p.name,
        p.pair,
        p.protocol,
        p.tokenA,
        p.tokenB,
        p.tokenAMint,
        p.tokenBMint,
        p.address,
        ...(p.tags ?? []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });

    // User-driven sort overrides the content-tab default; otherwise the tab
    // picks the order.
    list = [...list].sort((a, b) => {
      if (sort) {
        const sign = sort.dir === "asc" ? 1 : -1;
        let av = 0;
        let bv = 0;
        switch (sort.key) {
          case "tvl":
            av = parseUsd(a.tvl);
            bv = parseUsd(b.tvl);
            break;
          case "volume":
            av = volumeAtTf(a, timeframe);
            bv = volumeAtTf(b, timeframe);
            break;
          case "fees":
            av = feesAtTf(a, timeframe);
            bv = feesAtTf(b, timeframe);
            break;
          case "feeTvl":
            av = feeTvlPct(a, timeframe);
            bv = feeTvlPct(b, timeframe);
            break;
          case "apr":
            av = parsePct(a.apr);
            bv = parsePct(b.apr);
            break;
          case "age":
            av = a.createdAt ? nowSec - a.createdAt : -Infinity;
            bv = b.createdAt ? nowSec - b.createdAt : -Infinity;
            break;
        }
        return sign * (av - bv);
      }
      if (contentTab === "trending") return volumeAtTf(b, timeframe) - volumeAtTf(a, timeframe);
      if (contentTab === "stable") return parseUsd(b.tvl) - parseUsd(a.tvl);
      // top: best fee yield per dollar at risk.
      const af = feeTvlPct(a, timeframe);
      const bf = feeTvlPct(b, timeframe);
      if (bf !== af) return bf - af;
      return parseUsd(b.tvl) - parseUsd(a.tvl);
    });
    return list;
  }, [pools, debouncedQuery, searchQuery.data, contentTab, filters, nowSec, sort, timeframe]);

  const resetFilters = () => {
    setFilters(DEFAULT_FILTERS);
  };

  // Collect every visible mint for one batched price call. usePrices polls
  // every 5s and dedupes/sorts the keys so identical mint sets don't refetch.
  const visibleMints = useMemo(() => {
    const list: string[] = [];
    for (const p of filteredPools) {
      if (p.tokenAMint) list.push(p.tokenAMint);
      if (p.tokenBMint) list.push(p.tokenBMint);
    }
    return list;
  }, [filteredPools]);
  const pricesQuery = usePrices(visibleMints);
  const prices = pricesQuery.data;
  const iconsQuery = useTokenIcons(visibleMints);
  const icons = iconsQuery.data;

  if (loading) {
    return <PoolsSkeleton />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-red-500">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PoolsHeaderStats pools={pools} />
      <section className="panel-shell rounded-2xl p-4 sm:p-6">
        {/* Header row: tabs (left), timeframe + search + filter (right) */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <ContentTabBar value={contentTab} onChange={setContentTab} />

          <div className="flex flex-wrap items-center gap-2">
            <TimeframeSelect value={timeframe} onChange={setTimeframe} available={availableTfs} />
            <label className="relative block flex-1 lg:w-72 lg:flex-none">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search pair, mint, or pool address..."
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                className="h-9 rounded-md border-border bg-background pl-9 pr-9 font-mono text-xs tabular-nums sm:text-sm"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  {searchQuery.isFetching ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </label>
            <FilterPopover
              filters={filters}
              onChange={setFilters}
              activeCount={filterCount}
              onReset={resetFilters}
            />
          </div>
        </div>

        {/* Desktop table */}
        <div className="mt-5 hidden overflow-x-auto rounded-xl border border-border lg:block">
          <table className="w-full min-w-[1080px] table-fixed border-separate border-spacing-0 text-sm">
            <colgroup>
              <col className="w-12" />
              <col />
              <col className="w-24" />
              <col className="w-48" />
              <col className="w-28" />
              <col className="w-28" />
              <col className="w-28" />
              <col className="w-28" />
              <col className="w-28" />
            </colgroup>
            <thead>
              <tr className="bg-secondary/60 text-xs font-normal uppercase tracking-[0.18em] text-muted-foreground">
                <th className="px-4 py-3 text-left font-normal">#</th>
                <th className="px-4 py-3 text-left font-normal">Pool</th>
                <th className="px-4 py-3 text-right font-normal">
                  <SortHeader label="Pool Age" sortKey="age" current={sort} onToggle={toggleSort} />
                </th>
                <th className="px-4 py-3 text-right font-normal">
                  <span className="inline-flex items-center justify-end gap-1.5">
                    <span>Pool Price</span>
                    <LiveDot active={pricesQuery.isFetching} />
                  </span>
                </th>
                <th className="px-4 py-3 text-right font-normal">
                  <SortHeader label="TVL" sortKey="tvl" current={sort} onToggle={toggleSort} />
                </th>
                <th className="px-4 py-3 text-right font-normal">
                  <SortHeader label={`${tfLabel(timeframe)} Volume`} sortKey="volume" current={sort} onToggle={toggleSort} />
                </th>
                <th className="px-4 py-3 text-right font-normal">
                  <SortHeader label={`${tfLabel(timeframe)} Fees`} sortKey="fees" current={sort} onToggle={toggleSort} />
                </th>
                <th className="px-4 py-3 text-right font-normal">
                  <SortHeader label="Fee/TVL" sortKey="feeTvl" current={sort} onToggle={toggleSort} />
                </th>
                <th className="px-4 py-3 text-right font-normal">
                  <SortHeader label="APR" sortKey="apr" current={sort} onToggle={toggleSort} />
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredPools.map((p, i) => {
                const feeTvl = feeTvlPct(p, timeframe);
                const aprNum = parsePct(p.apr);
                return (
                  <tr
                    key={p.id}
                    onClick={() => openPool(p)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openPool(p);
                      }
                    }}
                    className="cursor-pointer border-t border-border bg-card transition-colors hover:bg-surface-elevated focus:bg-surface-elevated focus:outline-none"
                  >
                    <td className="px-4 py-4 align-middle">
                      <span className={`font-mono text-xs tabular-nums ${rankClass(i, sort)}`}>
                        #{i + 1}
                      </span>
                    </td>
                    <td className="px-4 py-4 align-middle">
                      <PoolPairCell pool={p} iconA={icons?.[p.tokenAMint]?.icon} iconB={icons?.[p.tokenBMint]?.icon} />
                    </td>
                    <td className="px-4 py-4 text-right align-middle font-mono text-xs tabular-nums text-muted-foreground">
                      {formatAge(p.createdAt, nowSec)}
                    </td>
                    <td className="px-4 py-4 align-middle">
                      <PoolPairPrice
                        tokenA={p.tokenA}
                        tokenB={p.tokenB}
                        tokenAMint={p.tokenAMint}
                        tokenBMint={p.tokenBMint}
                        prices={prices}
                        activePrice={p.activePrice}
                      />
                    </td>
                    <td className="px-4 py-4 text-right align-middle font-mono tabular-nums text-foreground">
                      {p.tvl}
                    </td>
                    <td className="px-4 py-4 text-right align-middle font-mono tabular-nums text-foreground">
                      {fmtUsd(volumeAtTf(p, timeframe))}
                    </td>
                    <td className="px-4 py-4 text-right align-middle font-mono tabular-nums text-foreground">
                      {fmtUsd(feesAtTf(p, timeframe))}
                    </td>
                    <td className={`px-4 py-4 text-right align-middle font-mono tabular-nums ${feeTvlColorClass(feeTvl)}`}>
                      {fmtFeeTvl(p, timeframe)}
                    </td>
                    <td className={`px-4 py-4 text-right align-middle font-mono tabular-nums ${aprColorClass(aprNum)}`}>
                      {p.apr}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="mt-5 grid gap-3 lg:hidden">
          {filteredPools.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => openPool(p)}
              className="rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/30"
            >
              <div className="flex items-start justify-between gap-3">
                <PoolPairCell pool={p} iconA={icons?.[p.tokenAMint]?.icon} iconB={icons?.[p.tokenBMint]?.icon} />
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {formatAge(p.createdAt, nowSec)}
                </span>
              </div>
              <div className="mt-3 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
                <p className="mb-1 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  <span>Pool price</span>
                  <LiveDot active={pricesQuery.isFetching} />
                </p>
                <PoolPairPrice
                  tokenA={p.tokenA}
                  tokenB={p.tokenB}
                  tokenAMint={p.tokenAMint}
                  tokenBMint={p.tokenBMint}
                  prices={prices}
                />
              </div>
              <div className="mt-3 grid grid-cols-4 gap-3 text-sm">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">TVL</p>
                  <p className="mt-0.5 font-mono tabular-nums text-foreground">{p.tvl}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{tfLabel(timeframe)} Vol</p>
                  <p className="mt-0.5 font-mono tabular-nums text-foreground">{fmtUsd(volumeAtTf(p, timeframe))}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Fee/TVL</p>
                  <p className="mt-0.5 font-mono tabular-nums text-foreground">{fmtFeeTvl(p, timeframe)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">APR</p>
                  <p className="mt-0.5 font-mono tabular-nums text-primary">{p.apr}</p>
                </div>
              </div>
            </button>
          ))}
        </div>

        {filteredPools.length === 0 && (
          <div className="mt-6 rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
            {debouncedQuery && searchQuery.isFetching ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Searching for{" "}
                <span className="font-mono text-foreground">{truncateMiddle(debouncedQuery)}</span>…
              </span>
            ) : debouncedQuery && searchQuery.isError ? (
              <>
                Search failed.{" "}
                <button
                  type="button"
                  onClick={() => searchQuery.refetch()}
                  className="text-primary hover:underline"
                >
                  Retry
                </button>
              </>
            ) : debouncedQuery ? (
              <>
                No pools matched{" "}
                <span className="font-mono text-foreground">{truncateMiddle(debouncedQuery)}</span>.
              </>
            ) : (
              "No pools match your filters."
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function PoolsHeaderStats({ pools }: { pools: Pool[] }) {
  // Aggregate from the unfiltered pool list so the headline numbers reflect
  // the full DLMM universe Octora indexes, not just whatever the user
  // narrowed the table to. 24h volume / fees are the buckets Meteora's own
  // discovery page surfaces; we mirror that to keep the comparison honest.
  const stats = useMemo(() => {
    let tvl = 0;
    let volume = 0;
    let fees = 0;
    for (const p of pools) {
      tvl += parseUsd(p.tvl);
      volume += p.volumeByTf?.["24h"] ?? 0;
      fees += p.feesByTf?.["24h"] ?? 0;
    }
    return { tvl, volume, fees };
  }, [pools]);

  return (
    <section className="grid gap-3 sm:grid-cols-3">
      <HeaderStat label="Total Value Locked" value={fmtUsdBig(stats.tvl)} />
      <HeaderStat label="24H Swap Volume" value={fmtUsdBig(stats.volume)} />
      <HeaderStat label="24H Fees Generated" value={fmtUsdBig(stats.fees)} />
    </section>
  );
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel-shell rounded-2xl p-4 sm:p-5">
      <p className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground sm:text-xs">
        {label}
      </p>
      <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-foreground sm:text-3xl">
        {value}
      </p>
    </div>
  );
}

/** Big-number USD formatter for header stats — same scale as fmtUsd but
 *  keeps one decimal for B/M/K so a $1.8B figure doesn't read as $2B. */
function fmtUsdBig(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function PoolsSkeleton() {
  return (
    <section className="panel-shell space-y-6 rounded-2xl p-4 sm:p-6">
      <div className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-12 w-full rounded-xl" />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-16 rounded-full" />
          ))}
        </div>
      </div>
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    </section>
  );
}

function ContentTabBar({
  value,
  onChange,
}: {
  value: ContentTab;
  onChange: (v: ContentTab) => void;
}) {
  const activeTab = CONTENT_TABS.find((t) => t.id === value);
  return (
    <div className="flex flex-col gap-2">
      <div
        role="tablist"
        aria-label="Pool sort categories"
        className="flex items-center gap-6 border-b border-border/60"
      >
        {CONTENT_TABS.map((t) => {
          const active = value === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(t.id)}
              className={`relative inline-flex items-center gap-2 whitespace-nowrap pb-3 pt-1 text-sm font-medium transition-colors ${
                active ? "text-primary" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon
                className={`h-4 w-4 transition-colors ${
                  active ? "text-primary" : "text-muted-foreground/80"
                }`}
              />
              {t.label}
              {active && (
                <span
                  aria-hidden
                  className="absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-primary"
                />
              )}
            </button>
          );
        })}
      </div>
      {activeTab && (
        <p className="text-xs text-muted-foreground">{activeTab.sub}</p>
      )}
    </div>
  );
}

function TimeframeSelect({
  value,
  onChange,
  available,
}: {
  value: TimeFrame;
  onChange: (v: TimeFrame) => void;
  available: Set<TimeFrame>;
}) {
  return (
    <div className="hidden items-center rounded-md border border-border bg-secondary/60 p-0.5 sm:inline-flex">
      {TIMEFRAMES.map((tf) => {
        const active = value === tf;
        const enabled = available.has(tf);
        return (
          <button
            key={tf}
            type="button"
            disabled={!enabled}
            title={enabled ? undefined : "Not available on this network"}
            onClick={() => onChange(tf)}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              active
                ? "bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(160_84%_45%_/_0.4)]"
                : enabled
                  ? "text-muted-foreground hover:text-foreground"
                  : "cursor-not-allowed text-muted-foreground/30"
            }`}
          >
            {tfLabel(tf)}
          </button>
        );
      })}
    </div>
  );
}

function formatAge(createdAtSec: number, nowSec: number): string {
  if (!createdAtSec || createdAtSec <= 0) return "—";
  const seconds = Math.max(0, nowSec - createdAtSec);
  const minutes = seconds / 60;
  const hours = minutes / 60;
  const days = hours / 24;
  const months = days / 30;
  const years = days / 365;
  if (years >= 1) {
    const y = Math.floor(years);
    const mo = Math.floor((days - y * 365) / 30);
    return mo > 0 ? `${y}y ${mo}mo` : `${y}y`;
  }
  if (months >= 1) {
    const mo = Math.floor(months);
    const d = Math.floor(days - mo * 30);
    return d > 0 ? `${mo}mo ${d}d` : `${mo}mo`;
  }
  if (days >= 1) {
    const d = Math.floor(days);
    const h = Math.floor(hours - d * 24);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  if (hours >= 1) return `${Math.floor(hours)}h`;
  return `${Math.max(1, Math.floor(minutes))}m`;
}

function FilterPopover({
  filters,
  onChange,
  activeCount,
  onReset,
}: {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  activeCount: number;
  onReset: () => void;
}) {
  const update = <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    onChange({ ...filters, [key]: value });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          <span className="hidden lg:inline">Filter</span>
          {activeCount > 0 && (
            <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full border border-primary/40 bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {activeCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] max-h-[80vh] overflow-y-auto p-0">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <p className="text-sm font-semibold text-foreground">Filter by</p>
          <button
            type="button"
            onClick={onReset}
            className="text-xs font-medium text-amber-400 transition-colors hover:text-amber-300"
          >
            Reset
          </button>
        </div>

        <div className="space-y-5 p-4">
          <FilterSection title="Pool Details">
            <RangeField
              label="Pool Age (Hours)"
              range={filters.poolAgeHours}
              onChange={(r) => update("poolAgeHours", r)}
            />
            <RangeField
              label="Volume"
              prefix="$"
              range={filters.volume}
              onChange={(r) => update("volume", r)}
            />
            <RangeField
              label="Fees"
              prefix="$"
              range={filters.fees}
              onChange={(r) => update("fees", r)}
            />
            <RangeField
              label="Fees/TVL %"
              suffix="%"
              range={filters.feeTvlPct}
              onChange={(r) => update("feeTvlPct", r)}
            />
            <RangeField
              label="TVL"
              prefix="$"
              range={filters.tvl}
              onChange={(r) => update("tvl", r)}
            />

            <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
              <div>
                <p className="text-sm text-foreground">Hide low TVL</p>
                <p className="text-[11px] text-muted-foreground">Pools with under $1K.</p>
              </div>
              <Switch
                checked={filters.hideLowTvl}
                onCheckedChange={(v) => update("hideLowTvl", v)}
              />
            </div>
          </FilterSection>

          <FilterSection title="DLMM">
            <RangeField
              label="Bin Step"
              range={filters.binStep}
              onChange={(r) => update("binStep", r)}
            />
          </FilterSection>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LiveDot({ active }: { active: boolean }) {
  return (
    <span
      title="Polling Jupiter every 5s"
      aria-hidden
      className={`h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_6px_hsl(160_84%_55%)] ${
        active ? "animate-pulse" : "opacity-70"
      }`}
    />
  );
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function RangeField({
  label,
  prefix,
  suffix,
  range,
  onChange,
}: {
  label: string;
  prefix?: string;
  suffix?: string;
  range: NumRange;
  onChange: (r: NumRange) => void;
}) {
  const minPlaceholder = `Min${prefix ? " " + prefix : suffix ? " " + suffix : ""}`;
  const maxPlaceholder = `Max${prefix ? " " + prefix : suffix ? " " + suffix : ""}`;
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-foreground/85">{label}</p>
      <div className="grid grid-cols-[1fr_8px_1fr] items-center gap-1">
        <input
          type="text"
          inputMode="decimal"
          value={range.min}
          onChange={(e) => onChange({ ...range, min: e.target.value })}
          placeholder={minPlaceholder}
          className="h-9 rounded-md border border-border bg-background px-2.5 font-mono text-xs tabular-nums text-foreground placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none"
        />
        <span className="text-center text-muted-foreground">–</span>
        <input
          type="text"
          inputMode="decimal"
          value={range.max}
          onChange={(e) => onChange({ ...range, max: e.target.value })}
          placeholder={maxPlaceholder}
          className="h-9 rounded-md border border-border bg-background px-2.5 font-mono text-xs tabular-nums text-foreground placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none"
        />
      </div>
    </div>
  );
}

function PoolPairCell({ pool, iconA, iconB }: { pool: Pool; iconA?: string | null; iconB?: string | null }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <PairAvatar a={pool.tokenA} b={pool.tokenB} iconA={iconA} iconB={iconB} />
      <div className="min-w-0">
        <p className="truncate font-medium text-foreground">{pool.name}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="font-mono">Fee {(pool.feeBps / 100).toFixed(2)}%</span>
          <span aria-hidden>·</span>
          <span className="font-mono">Bin {pool.binStep}</span>
          <span aria-hidden>·</span>
          <span className="rounded-full border border-border bg-secondary/60 px-1.5 py-0 text-[10px] uppercase tracking-[0.16em]">
            DLMM
          </span>
        </p>
      </div>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  current,
  onToggle,
}: {
  label: string;
  sortKey: SortKey;
  current: SortState | null;
  onToggle: (k: SortKey) => void;
}) {
  const active = current?.key === sortKey;
  const dir = active ? current!.dir : null;
  return (
    <button
      type="button"
      onClick={() => onToggle(sortKey)}
      className={`group inline-flex items-center justify-end gap-1 transition-colors ${
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <span>{label}</span>
      <ChevronDown
        className={`h-3 w-3 transition-[transform,opacity] ${
          active ? "opacity-100" : "opacity-30 group-hover:opacity-70"
        } ${dir === "asc" ? "rotate-180" : ""}`}
      />
    </button>
  );
}

/**
 * Top-3 ranks get medal-style tinting on the default content-tab order;
 * once the user picks an explicit sort, fall back to plain muted text since
 * "rank" no longer means "best".
 */
function rankClass(i: number, sort: SortState | null): string {
  if (sort) return "text-muted-foreground";
  if (i === 0) return "text-amber-300";
  if (i === 1) return "text-foreground/80";
  if (i === 2) return "text-orange-300";
  return "text-muted-foreground";
}

function feeTvlColorClass(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "text-muted-foreground";
  if (v >= 200) return "text-emerald-300";
  if (v >= 50) return "text-primary";
  if (v >= 10) return "text-primary/70";
  return "text-foreground/75";
}

function aprColorClass(v: number): string {
  if (!Number.isFinite(v)) return "text-muted-foreground";
  if (v >= 100) return "text-emerald-300";
  if (v >= 30) return "text-primary";
  if (v >= 10) return "text-primary/70";
  return "text-foreground/75";
}

