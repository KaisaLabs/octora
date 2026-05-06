import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Coins,
  Copy,
  Flame,
  Gem,
  Minus,
  Rocket,
  Search,
  ShieldCheck,
} from "lucide-react";

import type { DistributionShape, LiquidityBin, Pool } from "@/components/octora/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { BinLiquidityChart } from "@/components/octora/lp/BinLiquidityChart";
import { DistributionPreset } from "@/components/octora/lp/DistributionPreset";
import { PositionStatusPill } from "@/components/octora/lp/PositionStatusPill";
import { synthesizeBins } from "@/lib/bins";

type SortKey = "tvl" | "apr" | "volume";
type ProtocolFilter = "all" | "DLMM" | "DAMM";
type Strategy = {
  id: "stable" | "trending" | "blue-chip";
  title: string;
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
  shape: DistributionShape;
  matchTokens: string[];
};

const STRATEGIES: Strategy[] = [
  {
    id: "stable",
    title: "Stable yield",
    blurb: "Tight curve, USDC pairs.",
    icon: ShieldCheck,
    shape: "curve",
    matchTokens: ["USDC", "USDT", "USD"],
  },
  {
    id: "trending",
    title: "Trending memecoin",
    blurb: "Wide spot, high volatility.",
    icon: Rocket,
    shape: "spot",
    matchTokens: ["WIF", "BONK", "POPCAT", "MEW"],
  },
  {
    id: "blue-chip",
    title: "Blue-chip range",
    blurb: "Bid-ask edges on majors.",
    icon: Gem,
    shape: "bid-ask",
    matchTokens: ["SOL", "JUP", "JTO", "PYTH"],
  },
];

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

interface PoolsPageProps {
  pools: Pool[];
  loading: boolean;
  error: string | null;
}

export function PoolsPage({ pools, loading, error }: PoolsPageProps) {
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("tvl");
  const [protocolFilter, setProtocolFilter] = useState<ProtocolFilter>("all");
  const [strategyId, setStrategyId] = useState<Strategy["id"] | null>(null);
  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);

  const activeStrategy = useMemo(() => STRATEGIES.find((s) => s.id === strategyId) ?? null, [strategyId]);

  const filteredPools = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = pools.filter((p) => {
      if (protocolFilter !== "all" && !p.protocol.includes(protocolFilter)) return false;
      if (activeStrategy) {
        const tokens = [p.tokenA, p.tokenB].map((t) => t.toUpperCase());
        const wanted = activeStrategy.matchTokens.map((t) => t.toUpperCase());
        if (!tokens.some((t) => wanted.includes(t))) return false;
      }
      if (!q) return true;
      return [p.name, p.pair, p.protocol, p.tokenA, p.tokenB, p.address, ...(p.tags ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });

    list = [...list].sort((a, b) => {
      if (sortBy === "tvl") return parseUsd(b.tvl) - parseUsd(a.tvl);
      if (sortBy === "apr") return parsePct(b.apr) - parsePct(a.apr);
      return parseUsd(b.volume24h) - parseUsd(a.volume24h);
    });
    return list;
  }, [pools, query, sortBy, protocolFilter, activeStrategy]);

  const selectedPool = useMemo(
    () => pools.find((p) => p.id === selectedPoolId) ?? null,
    [pools, selectedPoolId],
  );

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
      <FeaturedStrategies activeId={strategyId} onSelect={setStrategyId} />

      <section className="panel-shell rounded-2xl p-4 sm:p-6">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                Discover pools
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {activeStrategy
                  ? `Filtered to ${activeStrategy.title.toLowerCase()} candidates.`
                  : "Search a pair or paste a contract address."}
              </p>
            </div>
            {activeStrategy && (
              <button
                type="button"
                onClick={() => setStrategyId(null)}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Clear strategy
              </button>
            )}
          </div>

          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search SOL, JUP, or paste CA..."
              className="h-12 rounded-xl border-border bg-background pl-10"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <FilterChip active={protocolFilter === "all"} onClick={() => setProtocolFilter("all")}>All</FilterChip>
            <FilterChip active={protocolFilter === "DLMM"} onClick={() => setProtocolFilter("DLMM")}>DLMM</FilterChip>
            <FilterChip active={protocolFilter === "DAMM"} onClick={() => setProtocolFilter("DAMM")}>DAMM</FilterChip>
            <span className="mx-1 h-5 w-px bg-border" />
            <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Sort</span>
            <FilterChip active={sortBy === "tvl"} onClick={() => setSortBy("tvl")}>TVL</FilterChip>
            <FilterChip active={sortBy === "apr"} onClick={() => setSortBy("apr")}>APR</FilterChip>
            <FilterChip active={sortBy === "volume"} onClick={() => setSortBy("volume")}>Volume</FilterChip>
          </div>
        </div>

        {/* Desktop table */}
        <div className="mt-6 hidden overflow-hidden rounded-xl border border-border lg:block">
          <div className="grid grid-cols-[1.4fr_1fr_1fr_1fr_1fr_120px] gap-4 bg-secondary/60 px-4 py-3 text-xs uppercase tracking-[0.18em] text-muted-foreground">
            <span>Pool</span>
            <span>Protocol</span>
            <span>TVL</span>
            <span>24h Volume</span>
            <span>APR</span>
            <span className="text-right">Action</span>
          </div>
          <div className="divide-y divide-border">
            {filteredPools.map((p) => (
              <div key={p.id} className="grid grid-cols-[1.4fr_1fr_1fr_1fr_1fr_120px] items-center gap-4 bg-card px-4 py-4 text-sm transition-colors hover:bg-surface-elevated">
                <div>
                  <p className="font-medium text-foreground">{p.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{p.pair}</p>
                </div>
                <p className="text-muted-foreground">{p.protocol}</p>
                <p className="text-foreground">{p.tvl}</p>
                <p className="text-foreground">{p.volume24h}</p>
                <p className="text-primary">{p.apr}</p>
                <div className="text-right">
                  <Button size="sm" variant="premium" onClick={() => setSelectedPoolId(p.id)}>
                    Open
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Mobile cards */}
        <div className="mt-6 grid gap-3 lg:hidden">
          {filteredPools.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedPoolId(p.id)}
              className="rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/30"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-base font-semibold text-foreground">{p.name}</p>
                  <p className="mt-0.5 text-xs uppercase tracking-[0.18em] text-muted-foreground">{p.protocol}</p>
                </div>
                <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-xs text-primary">{p.apr}</span>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">TVL</p>
                  <p className="mt-0.5 text-foreground">{p.tvl}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">24h Vol</p>
                  <p className="mt-0.5 text-foreground">{p.volume24h}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Fees</p>
                  <p className="mt-0.5 text-foreground">{p.fees24h}</p>
                </div>
              </div>
            </button>
          ))}
        </div>

        {filteredPools.length === 0 && (
          <div className="mt-6 rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
            No pools match your filters.
          </div>
        )}
      </section>

      {/* Pool Detail Sheet */}
      <Sheet open={!!selectedPool} onOpenChange={(open) => !open && setSelectedPoolId(null)}>
        <SheetContent side="bottom" className="max-h-[90vh] overflow-y-auto rounded-t-2xl border-t border-border bg-background p-0 sm:max-h-[85vh]">
          {selectedPool && (
            <PoolDetail pool={selectedPool} presetShape={activeStrategy?.shape} onBack={() => setSelectedPoolId(null)} />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function FeaturedStrategies({
  activeId,
  onSelect,
}: {
  activeId: Strategy["id"] | null;
  onSelect: (id: Strategy["id"] | null) => void;
}) {
  return (
    <section className="panel-shell rounded-2xl p-4 sm:p-5">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Featured</p>
          <h3 className="mt-1 font-display text-lg font-semibold tracking-tight text-foreground">
            Curated LP playbooks
          </h3>
        </div>
        <p className="hidden text-xs text-muted-foreground sm:block">
          Tap one to filter pools and preset the deposit shape.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {STRATEGIES.map((s) => {
          const Icon = s.icon;
          const active = activeId === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(active ? null : s.id)}
              className={`group flex items-center gap-3 rounded-xl border p-4 text-left transition-all ${
                active
                  ? "border-primary/50 bg-primary/5 shadow-[0_0_0_1px_hsl(160_84%_45%_/_0.25)]"
                  : "border-border bg-card hover:border-primary/30 hover:bg-surface-elevated/40"
              }`}
            >
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border ${
                  active ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-secondary/60 text-foreground/80"
                }`}
              >
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">{s.title}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{s.blurb}</p>
              </div>
              <span
                className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${
                  active ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-secondary/60 text-muted-foreground"
                }`}
              >
                {s.shape}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ---------------- Pool detail ---------------- */

function PoolDetail({ pool, presetShape, onBack }: { pool: Pool; presetShape?: DistributionShape; onBack: () => void }) {
  const [detailTab, setDetailTab] = useState("deposit");

  return (
    <div className="space-y-5 p-4 sm:p-6">
      {/* Header */}
      <div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to pools
        </button>

        <div className="mt-4 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                {pool.protocol}
              </span>
              <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Fee {pool.feeBps} bps
              </span>
              {(pool.tags ?? []).slice(0, 2).map((t) => (
                <span key={t} className="rounded-full border border-border bg-secondary/60 px-2.5 py-1 text-[11px] text-muted-foreground">
                  {t}
                </span>
              ))}
            </div>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              {pool.name}
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="font-mono text-xs">{pool.address}</span>
              <button type="button" className="inline-flex items-center gap-1 text-foreground transition-colors hover:text-primary">
                <Copy className="h-3.5 w-3.5" /> Copy
              </button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:gap-3 lg:w-[480px]">
            <PoolInfoStat label="TVL" value={pool.tvl} />
            <PoolInfoStat label="24h Vol" value={pool.volume24h} />
            <PoolInfoStat label="APR" value={pool.apr} highlight />
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <InfoCard label="Price range" value={pool.priceRange} helper={pool.binRange} />
          <InfoCard label="Depth" value={pool.depth} helper={pool.risk} />
          <InfoCard
            label="Allocation"
            value={`${pool.allocation.tokenA}% ${pool.tokenA} / ${pool.allocation.tokenB}% ${pool.tokenB}`}
            helper="Suggested split"
          />
          <InfoCard label="24h Fees" value={pool.fees24h} helper="Across active bins" />
        </div>
      </div>

      {/* Action tabs */}
      <Tabs value={detailTab} onValueChange={setDetailTab}>
        <TabsList className="h-auto w-full justify-start overflow-x-auto rounded-lg border border-border bg-secondary/60 p-1 sm:w-auto">
          <TabsTrigger value="deposit" className="rounded-md px-4 py-2 text-sm data-[state=active]:bg-surface-elevated">Add liquidity</TabsTrigger>
          <TabsTrigger value="claim" className="rounded-md px-4 py-2 text-sm data-[state=active]:bg-surface-elevated">Claim</TabsTrigger>
          <TabsTrigger value="withdraw" className="rounded-md px-4 py-2 text-sm data-[state=active]:bg-surface-elevated">Withdraw</TabsTrigger>
        </TabsList>

        <TabsContent value="deposit" className="mt-4">
          <DepositPanel pool={pool} presetShape={presetShape} />
        </TabsContent>
        <TabsContent value="claim" className="mt-4">
          <ClaimPanel pool={pool} />
        </TabsContent>
        <TabsContent value="withdraw" className="mt-4">
          <WithdrawPanel pool={pool} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ---------------- Deposit ---------------- */

function DepositPanel({ pool, presetShape }: { pool: Pool; presetShape?: DistributionShape }) {
  const bins = useMemo<LiquidityBin[]>(() => synthesizeBins(pool, { count: 61 }), [pool]);
  const activeBinId = bins[Math.floor(bins.length / 2)]?.binId ?? 0;

  const [depositUsd, setDepositUsd] = useState(2500);
  const [shape, setShape] = useState<DistributionShape>(presetShape ?? "curve");

  useEffect(() => {
    if (presetShape) setShape(presetShape);
  }, [presetShape]);
  const [range, setRange] = useState<{ lower: number; upper: number }>(() => ({
    lower: activeBinId - 8,
    upper: activeBinId + 8,
  }));

  // Re-center range when pool changes.
  useEffect(() => {
    setRange({ lower: activeBinId - 8, upper: activeBinId + 8 });
  }, [activeBinId]);

  const lowerPrice = bins.find((b) => b.binId === range.lower)?.price ?? 0;
  const upperPrice = bins.find((b) => b.binId === range.upper)?.price ?? 0;
  const activePrice = bins.find((b) => b.binId === activeBinId)?.price ?? 0;

  const lowerPct = activePrice ? ((lowerPrice - activePrice) / activePrice) * 100 : 0;
  const upperPct = activePrice ? ((upperPrice - activePrice) / activePrice) * 100 : 0;
  const binsCovered = Math.max(0, range.upper - range.lower + 1);

  const projection = useMemo(() => {
    const entryFee = depositUsd * (pool.feeBps / 10000);
    // Concentration multiplier: narrower range → higher fee share per dollar.
    // Crude proxy: full bin window in pool ≈ 60 bins.
    const concentration = Math.max(1, 60 / Math.max(binsCovered, 1));
    const baseDaily = (depositUsd * (parseFloat(pool.apr) / 100)) / 365;
    const estimatedDaily = baseDaily * Math.min(concentration, 6);
    const monthlyRange = estimatedDaily * 30;
    return { entryFee, estimatedDaily, monthlyRange, concentration };
  }, [depositUsd, pool, binsCovered]);

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Strategy</p>
          <h3 className="mt-1 font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Shape your liquidity
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Drag the handles to set your range. Pick a shape to spread liquidity.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start text-xs text-muted-foreground">
          <span className="rounded-full border border-border bg-secondary/60 px-2.5 py-1 font-mono">
            Bin step {pool.binStep || "—"}
          </span>
          <span className="rounded-full border border-border bg-secondary/60 px-2.5 py-1 font-mono">
            {binsCovered} bins
          </span>
        </div>
      </div>

      {/* Bin chart */}
      <div className="rounded-2xl border border-border/70 bg-card/60 p-3 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Active price</span>
            <span className="font-mono text-base text-foreground tabular-nums">
              {formatPrice(activePrice)}
            </span>
            <span className="text-xs text-muted-foreground">
              {pool.tokenA}/{pool.tokenB}
            </span>
          </div>
          <PositionStatusPill inRange size="sm" label="Active in range" />
        </div>

        <BinLiquidityChart
          bins={bins}
          activeBinId={activeBinId}
          range={range}
          shape={shape}
          depositUsd={depositUsd}
          onRangeChange={setRange}
          height={240}
        />

        <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-3">
          <RangeReadout
            label="Min price"
            price={lowerPrice}
            pct={lowerPct}
            onAdjust={(d) => setRange((r) => ({ lower: r.lower + d, upper: r.upper }))}
          />
          <RangeReadout label="Active" price={activePrice} pct={0} center />
          <RangeReadout
            label="Max price"
            price={upperPrice}
            pct={upperPct}
            onAdjust={(d) => setRange((r) => ({ lower: r.lower, upper: r.upper + d }))}
          />
        </div>
      </div>

      {/* Distribution + amount */}
      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">Distribution</p>
            <DistributionPreset value={shape} onChange={setShape} />
          </div>

          <label className="block space-y-2">
            <span className="text-sm text-muted-foreground">Deposit (USD)</span>
            <Input
              type="number"
              min={100}
              step={100}
              value={depositUsd}
              onChange={(e) => setDepositUsd(Number(e.target.value))}
              className="h-12 rounded-xl border-border bg-background font-mono text-base tabular-nums"
            />
            <div className="flex flex-wrap gap-2 pt-1">
              {[500, 1000, 5000, 10000].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setDepositUsd(v)}
                  className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  ${v.toLocaleString()}
                </button>
              ))}
            </div>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <StrategyTile
              title={`${pool.tokenA} allocation`}
              value={`$${((depositUsd * pool.allocation.tokenA) / 100).toFixed(0)}`}
              helper={`${pool.allocation.tokenA}%`}
            />
            <StrategyTile
              title={`${pool.tokenB} allocation`}
              value={`$${((depositUsd * pool.allocation.tokenB) / 100).toFixed(0)}`}
              helper={`${pool.allocation.tokenB}%`}
            />
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Summary</p>
          <div className="mt-4 space-y-3.5">
            <OutcomeRow label="Bins entered" value={`${binsCovered}`} />
            <OutcomeRow
              label="Capital efficiency"
              value={`${projection.concentration.toFixed(1)}x`}
              accent
            />
            <OutcomeRow label="Entry fee" value={`$${projection.entryFee.toFixed(2)}`} />
            <OutcomeRow label="Est. daily fees" value={`$${projection.estimatedDaily.toFixed(2)}`} />
            <OutcomeRow label="30d est." value={`$${projection.monthlyRange.toFixed(2)}`} />
            <OutcomeRow label="Execution" value="Private relay" />
          </div>
          <Button variant="hero" size="lg" className="mt-5 w-full justify-center rounded-xl">
            Deposit privately
            <ArrowRight />
          </Button>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            Routed via Vanish + MagicBlock. Origin wallet stays hidden.
          </p>
        </div>
      </div>
    </section>
  );
}

function formatPrice(p: number): string {
  if (!Number.isFinite(p) || p === 0) return "—";
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  return p.toExponential(3);
}

function RangeReadout({
  label,
  price,
  pct,
  center,
  onAdjust,
}: {
  label: string;
  price: number;
  pct: number;
  center?: boolean;
  onAdjust?: (delta: number) => void;
}) {
  return (
    <div
      className={`rounded-xl border ${
        center ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-secondary/40"
      } px-3 py-2.5`}
    >
      <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        <span>{label}</span>
        {onAdjust && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onAdjust(-1)}
              className="rounded border border-border bg-card px-1.5 leading-none text-foreground/70 transition-colors hover:text-foreground"
            >
              −
            </button>
            <button
              type="button"
              onClick={() => onAdjust(1)}
              className="rounded border border-border bg-card px-1.5 leading-none text-foreground/70 transition-colors hover:text-foreground"
            >
              +
            </button>
          </div>
        )}
      </div>
      <p className="mt-1.5 font-mono text-sm text-foreground tabular-nums">{formatPrice(price)}</p>
      <p className={`mt-0.5 text-[11px] tabular-nums ${center ? "text-amber-400" : pct >= 0 ? "text-primary" : "text-muted-foreground"}`}>
        {center ? "Mid price" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
      </p>
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

/* ---------------- Claim ---------------- */

function ClaimPanel({ pool }: { pool: Pool }) {
  const fees = (parseFloat(pool.apr) / 365) * 30 * 100;
  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Earnings</p>
          <h3 className="mt-1 text-xl font-semibold text-foreground sm:text-2xl">Claim fees & rewards</h3>
        </div>
        <Coins className="h-5 w-5 text-primary" />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <ClaimTile label="Unclaimed fees" value={`$${fees.toFixed(2)}`} sub={pool.tokenA + " + " + pool.tokenB} />
        <ClaimTile label="MET rewards" value="124.8 MET" sub="≈ $38.20" />
        <ClaimTile label="Last claim" value="3 days ago" sub="Privately settled" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Button variant="hero" size="lg" className="w-full justify-center rounded-xl">
          <Coins />
          Claim fees
        </Button>
        <Button variant="premium" size="lg" className="w-full justify-center rounded-xl">
          <Flame />
          Claim rewards
        </Button>
      </div>

      <p className="text-xs leading-5 text-muted-foreground">
        Claims settle to your session wallet, then are forwarded through the private route to your funding address.
      </p>
    </section>
  );
}

/* ---------------- Withdraw ---------------- */

function WithdrawPanel({ pool }: { pool: Pool }) {
  const [pct, setPct] = useState(50);
  const positionValue = 12480;
  const withdrawValue = (positionValue * pct) / 100;

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Remove liquidity</p>
          <h3 className="mt-1 text-xl font-semibold text-foreground sm:text-2xl">Withdraw from {pool.name}</h3>
        </div>
        <Minus className="h-5 w-5 text-primary" />
      </div>

      <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Withdraw amount</p>
          <p className="text-sm font-medium text-foreground">{pct}%</p>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={pct}
          onChange={(e) => setPct(Number(e.target.value))}
          className="mt-3 w-full accent-[hsl(var(--primary))]"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {[25, 50, 75, 100].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setPct(v)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                pct === v ? "border-primary/40 bg-surface-elevated text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {v}%
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <ClaimTile label="Receive" value={`$${withdrawValue.toFixed(0)}`} sub="Estimated value" />
        <ClaimTile label={pool.tokenA} value={`${((withdrawValue * pool.allocation.tokenA) / 100).toFixed(2)}`} sub="Tokens" />
        <ClaimTile label={pool.tokenB} value={`${((withdrawValue * pool.allocation.tokenB) / 100).toFixed(2)}`} sub="Tokens" />
      </div>

      <Button variant="hero" size="lg" className="w-full justify-center rounded-xl">
        Withdraw privately
        <ArrowRight />
      </Button>
      <p className="text-xs leading-5 text-muted-foreground">
        Funds return through the private route — your main wallet remains hidden from on-chain observers.
      </p>
    </section>
  );
}

/* ---------------- Small components ---------------- */

function PoolInfoStat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
      <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground sm:text-xs">{label}</p>
      <p className={`mt-1.5 text-base font-semibold sm:text-lg ${highlight ? "text-primary" : "text-foreground"}`}>{value}</p>
    </div>
  );
}

function InfoCard({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-sm font-medium text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{helper}</p>
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
        active ? "border-primary/40 bg-surface-elevated text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function StrategyTile({ title, value, helper }: { title: string; value: string; helper: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="mt-1.5 text-xl font-semibold text-foreground sm:text-2xl">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{helper}</p>
    </div>
  );
}

function ClaimTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-lg font-semibold text-foreground sm:text-xl">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

function OutcomeRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/80 pb-3 last:border-b-0 last:pb-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`font-mono text-sm font-medium tabular-nums ${accent ? "text-primary" : "text-foreground"}`}>
        {value}
      </span>
    </div>
  );
}
