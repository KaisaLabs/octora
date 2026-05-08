import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search, SlidersHorizontal, X } from "lucide-react";

import type { Pool } from "@/components/octora/types";
import { listPools, mapPoolSummary, NETWORK } from "@/lib/api";
import { DEFAULT_CLUSTER } from "@/lib/solana/config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { PoolPairPrice } from "@/components/octora/PoolPairPrice";
import { usePrices } from "@/hooks/usePrices";

type ContentTab = "top" | "trending" | "stable";
type TimeFrame = "5m" | "30m" | "1h" | "2h" | "4h" | "12h" | "24h";

const CONTENT_TABS: Array<{ id: ContentTab; label: string; sub: string }> = [
  { id: "top", label: "Top performers", sub: "Best fee yield per dollar" },
  { id: "trending", label: "Trending", sub: "Most 24h volume" },
  { id: "stable", label: "Stable", sub: "USDC / USDT pairs" },
];

const TIMEFRAMES: TimeFrame[] = ["5m", "30m", "1h", "2h", "4h", "12h", "24h"];

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

/** Annualized fee yield against TVL: 24h fees * 365 / TVL, expressed as percent. */
function feeTvlPct(p: Pool): number {
  const tvl = parseUsd(p.tvl);
  if (tvl <= 0) return 0;
  const fees = parseUsd(p.fees24h);
  return ((fees * 365) / tvl) * 100;
}

function truncateMiddle(s: string, head = 6, tail = 6): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function fmtFeeTvl(p: Pool): string {
  const v = feeTvlPct(p);
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
      if (!inRange(parseUsd(p.volume24h), filters.volume)) return false;
      if (!inRange(parseUsd(p.fees24h), filters.fees)) return false;
      if (!inRange(feeTvlPct(p), filters.feeTvlPct)) return false;
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

    // Content tab implies sort. No separate sort UI.
    list = [...list].sort((a, b) => {
      if (contentTab === "trending") return parseUsd(b.volume24h) - parseUsd(a.volume24h);
      if (contentTab === "stable") return parseUsd(b.tvl) - parseUsd(a.tvl);
      // top: best fee yield per dollar at risk.
      const af = feeTvlPct(a);
      const bf = feeTvlPct(b);
      if (bf !== af) return bf - af;
      return parseUsd(b.tvl) - parseUsd(a.tvl);
    });
    return list;
  }, [pools, debouncedQuery, searchQuery.data, contentTab, filters, nowSec]);

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
      <section className="panel-shell rounded-2xl p-4 sm:p-6">
        {/* Header row: tabs (left), timeframe + search + filter (right) */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <ContentTabBar value={contentTab} onChange={setContentTab} />

          <div className="flex flex-wrap items-center gap-2">
            <TimeframeSelect value={timeframe} onChange={setTimeframe} />
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
          <div className="min-w-[1280px]">
            <div className="grid grid-cols-[40px_minmax(220px,2fr)_100px_minmax(150px,1.2fr)_110px_110px_110px_110px_110px_120px] gap-3 bg-secondary/60 px-4 py-3 text-xs uppercase tracking-[0.18em] text-muted-foreground">
              <span className="text-left">#</span>
              <span className="text-left">Pool</span>
              <span className="text-right">Pool Age</span>
              <span className="inline-flex items-center justify-end gap-1.5 text-right">
                <span>Live Price (24h)</span>
                <LiveDot active={pricesQuery.isFetching} />
              </span>
              <span className="text-right">TVL</span>
              <span className="text-right">24h Volume</span>
              <span className="text-right">24h Fees</span>
              <span className="text-right">Fee/TVL</span>
              <span className="text-right">APR</span>
              <span className="text-right">Action</span>
            </div>
            <div className="divide-y divide-border">
              {filteredPools.map((p, i) => (
                <div
                  key={p.id}
                  className="grid grid-cols-[40px_minmax(220px,2fr)_100px_minmax(150px,1.2fr)_110px_110px_110px_110px_110px_120px] items-center gap-3 bg-card px-4 py-4 text-sm transition-colors hover:bg-surface-elevated"
                >
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">#{i + 1}</span>
                  <PoolPairCell pool={p} />
                  <p className="text-right font-mono text-xs text-muted-foreground tabular-nums">
                    {formatAge(p.createdAt, nowSec)}
                  </p>
                  <PoolPairPrice
                    tokenA={p.tokenA}
                    tokenB={p.tokenB}
                    tokenAMint={p.tokenAMint}
                    tokenBMint={p.tokenBMint}
                    prices={prices}
                  />
                  <p className="text-right font-mono tabular-nums text-foreground">{p.tvl}</p>
                  <p className="text-right font-mono tabular-nums text-foreground">{p.volume24h}</p>
                  <p className="text-right font-mono tabular-nums text-foreground">{p.fees24h}</p>
                  <p className="text-right font-mono tabular-nums text-foreground">{fmtFeeTvl(p)}</p>
                  <p className="text-right font-mono tabular-nums text-primary">{p.apr}</p>
                  <div className="text-right">
                    <Button size="sm" variant="premium" onClick={() => openPool(p)}>
                      Open
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
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
                <PoolPairCell pool={p} />
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {formatAge(p.createdAt, nowSec)}
                </span>
              </div>
              <div className="mt-3 rounded-lg border border-border/60 bg-secondary/30 px-3 py-2">
                <p className="mb-1 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  <span>Live price · 24h</span>
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
                  <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">24h Vol</p>
                  <p className="mt-0.5 font-mono tabular-nums text-foreground">{p.volume24h}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Fee/TVL</p>
                  <p className="mt-0.5 font-mono tabular-nums text-foreground">{fmtFeeTvl(p)}</p>
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
  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      {CONTENT_TABS.map((t) => {
        const active = value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            title={t.sub}
            className={`relative whitespace-nowrap rounded-full px-3.5 py-2 text-sm transition-colors ${
              active
                ? "font-display text-xl font-semibold tracking-tight text-foreground sm:text-2xl"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function TimeframeSelect({
  value,
  onChange,
}: {
  value: TimeFrame;
  onChange: (v: TimeFrame) => void;
}) {
  return (
    <div className="hidden items-center rounded-md border border-border bg-secondary/60 p-0.5 sm:inline-flex">
      {TIMEFRAMES.map((tf) => {
        const active = value === tf;
        return (
          <button
            key={tf}
            type="button"
            onClick={() => onChange(tf)}
            className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              active
                ? "bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(160_84%_45%_/_0.4)]"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tf.replace("h", "H").replace("m", "m")}
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

function PoolPairCell({ pool }: { pool: Pool }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <PairAvatar a={pool.tokenA} b={pool.tokenB} />
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

function PairAvatar({ a, b }: { a: string; b: string }) {
  return (
    <div className="relative h-8 w-12 shrink-0">
      <span className="absolute left-0 top-0 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-secondary/60 text-[10px] font-semibold uppercase text-foreground/80">
        {initials(a)}
      </span>
      <span className="absolute left-4 top-0 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-secondary text-[10px] font-semibold uppercase text-foreground/80">
        {initials(b)}
      </span>
    </div>
  );
}

function initials(token: string): string {
  if (!token) return "?";
  return token.slice(0, 2).toUpperCase();
}

