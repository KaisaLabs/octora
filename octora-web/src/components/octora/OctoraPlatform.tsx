import { useMemo, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BriefcaseBusiness,
  CircleDollarSign,
  Coins,
  Compass,
  Copy,
  Flame,
  Minus,
  Search,
  Shield,
} from "lucide-react";

import { PortfolioActivity, PortfolioPosition, Pool } from "@/components/octora/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface PortfolioSummary {
  totalValue: string;
  totalFees: string;
  activePositions: number;
  privateSessions: number;
}

interface OctoraPlatformProps {
  pools: Pool[];
  positions: PortfolioPosition[];
  activity: PortfolioActivity[];
  summary: PortfolioSummary;
}

type SortKey = "tvl" | "apr" | "volume";
type ProtocolFilter = "all" | "DLMM" | "DAMM";

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

export function OctoraPlatform({ pools, positions, activity, summary }: OctoraPlatformProps) {
  const [activeTab, setActiveTab] = useState("discover");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("tvl");
  const [protocolFilter, setProtocolFilter] = useState<ProtocolFilter>("all");
  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);

  const filteredPools = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = pools.filter((p) => {
      if (protocolFilter !== "all" && !p.protocol.includes(protocolFilter)) return false;
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
  }, [pools, query, sortBy, protocolFilter]);

  const selectedPool = useMemo(
    () => pools.find((p) => p.id === selectedPoolId) ?? null,
    [pools, selectedPoolId],
  );

  return (
    <div className="container pb-14 pt-6 sm:pt-8">
      {/* Top metrics */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Protected TVL" value={summary.totalValue} icon={Shield} />
        <MetricCard label="Fees earned" value={summary.totalFees} icon={CircleDollarSign} />
        <MetricCard label="Open positions" value={String(summary.activePositions)} icon={BriefcaseBusiness} />
        <MetricCard label="Private sessions" value={String(summary.privateSessions)} icon={Activity} />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <TabsList className="h-auto w-full justify-start overflow-x-auto rounded-lg border border-border bg-secondary/60 p-1 sm:w-auto">
          <TabsTrigger value="discover" className="rounded-md px-4 py-2 text-sm data-[state=active]:bg-surface-elevated">
            Pools
          </TabsTrigger>
          <TabsTrigger value="portfolio" className="rounded-md px-4 py-2 text-sm data-[state=active]:bg-surface-elevated">
            Portfolio
          </TabsTrigger>
          <TabsTrigger value="activity" className="rounded-md px-4 py-2 text-sm data-[state=active]:bg-surface-elevated">
            Activity
          </TabsTrigger>
        </TabsList>

        {/* POOLS TAB */}
        <TabsContent value="discover" className="space-y-6 animate-fade-in">
          {!selectedPool ? (
            <PoolBrowser
              pools={filteredPools}
              query={query}
              setQuery={setQuery}
              sortBy={sortBy}
              setSortBy={setSortBy}
              protocolFilter={protocolFilter}
              setProtocolFilter={setProtocolFilter}
              onSelect={(id) => setSelectedPoolId(id)}
            />
          ) : (
            <PoolDetail pool={selectedPool} onBack={() => setSelectedPoolId(null)} />
          )}
        </TabsContent>

        {/* PORTFOLIO TAB */}
        <TabsContent value="portfolio" className="space-y-6 animate-fade-in">
          <PortfolioView positions={positions} />
        </TabsContent>

        {/* ACTIVITY TAB */}
        <TabsContent value="activity" className="space-y-6 animate-fade-in">
          <ActivityView activity={activity} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ---------------- Pool browser ---------------- */

function PoolBrowser({
  pools,
  query,
  setQuery,
  sortBy,
  setSortBy,
  protocolFilter,
  setProtocolFilter,
  onSelect,
}: {
  pools: Pool[];
  query: string;
  setQuery: (v: string) => void;
  sortBy: SortKey;
  setSortBy: (v: SortKey) => void;
  protocolFilter: ProtocolFilter;
  setProtocolFilter: (v: ProtocolFilter) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="panel-shell rounded-2xl p-4 sm:p-6">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-foreground sm:text-2xl">Discover pools</h2>
            <p className="mt-1 text-sm text-muted-foreground">Search a pair or paste a contract address.</p>
          </div>
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
          {pools.map((p) => (
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
                <Button size="sm" variant="premium" onClick={() => onSelect(p.id)}>
                  Open
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Mobile cards */}
      <div className="mt-6 grid gap-3 lg:hidden">
        {pools.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
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

      {pools.length === 0 && (
        <div className="mt-6 rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No pools match your filters.
        </div>
      )}
    </section>
  );
}

/* ---------------- Pool detail ---------------- */

function PoolDetail({ pool, onBack }: { pool: Pool; onBack: () => void }) {
  const [detailTab, setDetailTab] = useState("deposit");

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="panel-shell rounded-2xl p-4 sm:p-6">
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
            <h2 className="text-2xl font-semibold text-foreground sm:text-3xl">{pool.name}</h2>
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
          <DepositPanel pool={pool} />
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

function DepositPanel({ pool }: { pool: Pool }) {
  const [depositUsd, setDepositUsd] = useState(2500);
  const [mode, setMode] = useState<"balanced" | "spot" | "curve">("balanced");

  const projection = useMemo(() => {
    const entryFee = depositUsd * (pool.feeBps / 10000);
    const estimatedDaily = (depositUsd * (parseFloat(pool.apr) / 100)) / 365;
    const monthlyRange = estimatedDaily * 30;
    const tokenAAmount = (depositUsd * pool.allocation.tokenA) / 100;
    const tokenBAmount = (depositUsd * pool.allocation.tokenB) / 100;
    return { entryFee, estimatedDaily, monthlyRange, tokenAAmount, tokenBAmount };
  }, [depositUsd, pool]);

  return (
    <section className="panel-shell rounded-2xl p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Strategy</p>
          <h3 className="mt-1 text-xl font-semibold text-foreground sm:text-2xl">Configure position</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          <ModeButton active={mode === "balanced"} onClick={() => setMode("balanced")} label="Balanced" />
          <ModeButton active={mode === "spot"} onClick={() => setMode("spot")} label="Spot heavy" />
          <ModeButton active={mode === "curve"} onClick={() => setMode("curve")} label="Wide curve" />
        </div>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          <label className="block space-y-2">
            <span className="text-sm text-muted-foreground">Deposit (USD)</span>
            <Input
              type="number"
              min={100}
              step={100}
              value={depositUsd}
              onChange={(e) => setDepositUsd(Number(e.target.value))}
              className="h-12 rounded-xl border-border bg-background text-base"
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
              value={`$${projection.tokenAAmount.toFixed(0)}`}
              helper={`${pool.allocation.tokenA}%`}
            />
            <StrategyTile
              title={`${pool.tokenB} allocation`}
              value={`$${projection.tokenBAmount.toFixed(0)}`}
              helper={`${pool.allocation.tokenB}%`}
            />
          </div>

          <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-foreground">Range</p>
              <Compass className="h-4 w-4 text-primary" />
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              <RangeBand label="Lower" value={mode === "curve" ? "-9.0%" : mode === "spot" ? "-2.0%" : "-4.5%"} />
              <RangeBand label="Center" value="Mid price" />
              <RangeBand label="Upper" value={mode === "curve" ? "+12.0%" : mode === "spot" ? "+2.5%" : "+5.2%"} />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Summary</p>
          <div className="mt-4 space-y-3.5">
            <OutcomeRow label="Entry fee" value={`$${projection.entryFee.toFixed(2)}`} />
            <OutcomeRow label="Daily fees est." value={`$${projection.estimatedDaily.toFixed(2)}`} />
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

/* ---------------- Claim ---------------- */

function ClaimPanel({ pool }: { pool: Pool }) {
  const fees = (parseFloat(pool.apr) / 365) * 30 * 100; // demo number
  return (
    <section className="panel-shell rounded-2xl p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Earnings</p>
          <h3 className="mt-1 text-xl font-semibold text-foreground sm:text-2xl">Claim fees & rewards</h3>
        </div>
        <Coins className="h-5 w-5 text-primary" />
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <ClaimTile label="Unclaimed fees" value={`$${fees.toFixed(2)}`} sub={pool.tokenA + " + " + pool.tokenB} />
        <ClaimTile label="MET rewards" value="124.8 MET" sub="≈ $38.20" />
        <ClaimTile label="Last claim" value="3 days ago" sub="Privately settled" />
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <Button variant="hero" size="lg" className="w-full justify-center rounded-xl">
          <Coins />
          Claim fees
        </Button>
        <Button variant="premium" size="lg" className="w-full justify-center rounded-xl">
          <Flame />
          Claim rewards
        </Button>
      </div>

      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        Claims settle to your session wallet, then are forwarded through the private route to your funding address.
      </p>
    </section>
  );
}

/* ---------------- Withdraw ---------------- */

function WithdrawPanel({ pool }: { pool: Pool }) {
  const [pct, setPct] = useState(50);
  const positionValue = 12480; // demo
  const withdrawValue = (positionValue * pct) / 100;

  return (
    <section className="panel-shell rounded-2xl p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Remove liquidity</p>
          <h3 className="mt-1 text-xl font-semibold text-foreground sm:text-2xl">Withdraw from {pool.name}</h3>
        </div>
        <Minus className="h-5 w-5 text-primary" />
      </div>

      <div className="mt-6 space-y-5">
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
      </div>
    </section>
  );
}

/* ---------------- Portfolio ---------------- */

function PortfolioView({ positions }: { positions: PortfolioPosition[] }) {
  return (
    <section className="panel-shell rounded-2xl p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Open positions</p>
          <h2 className="mt-1 text-xl font-semibold text-foreground sm:text-2xl">Your private LP</h2>
        </div>
      </div>

      {/* Desktop table */}
      <div className="mt-6 hidden overflow-hidden rounded-xl border border-border lg:block">
        <div className="grid grid-cols-[1.4fr_1fr_1fr_1fr_0.8fr_140px] gap-4 bg-secondary/60 px-4 py-3 text-xs uppercase tracking-[0.18em] text-muted-foreground">
          <span>Pool</span>
          <span>Deposited</span>
          <span>Value</span>
          <span>Fees</span>
          <span>Status</span>
          <span className="text-right">Manage</span>
        </div>
        <div className="divide-y divide-border">
          {positions.map((p) => (
            <div key={p.id} className="grid grid-cols-[1.4fr_1fr_1fr_1fr_0.8fr_140px] items-center gap-4 bg-card px-4 py-4 text-sm">
              <div>
                <p className="font-medium text-foreground">{p.poolName}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{p.protocol}</p>
              </div>
              <p className="text-foreground">{p.deposited}</p>
              <p className="text-foreground">{p.value}</p>
              <p className="text-primary">{p.feesEarned}</p>
              <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-xs text-foreground">{p.status}</span>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="premium">Claim</Button>
                <Button size="sm" variant="subtle">Withdraw</Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Mobile cards */}
      <div className="mt-6 grid gap-3 lg:hidden">
        {positions.map((p) => (
          <div key={p.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-base font-semibold text-foreground">{p.poolName}</p>
                <p className="mt-0.5 text-xs uppercase tracking-[0.18em] text-muted-foreground">{p.protocol}</p>
              </div>
              <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-xs text-foreground">{p.status}</span>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Deposited</p>
                <p className="mt-0.5 text-foreground">{p.deposited}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Value</p>
                <p className="mt-0.5 text-foreground">{p.value}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Fees</p>
                <p className="mt-0.5 text-primary">{p.feesEarned}</p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Button size="sm" variant="premium" className="w-full">Claim</Button>
              <Button size="sm" variant="subtle" className="w-full">Withdraw</Button>
            </div>
          </div>
        ))}
      </div>

      {positions.length === 0 && (
        <div className="mt-6 rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No open positions yet.
        </div>
      )}
    </section>
  );
}

/* ---------------- Activity ---------------- */

function ActivityView({ activity }: { activity: PortfolioActivity[] }) {
  return (
    <section className="panel-shell rounded-2xl p-4 sm:p-6">
      <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Recent activity</p>
      <h2 className="mt-1 text-xl font-semibold text-foreground sm:text-2xl">Session timeline</h2>

      <div className="mt-6 space-y-3">
        {activity.map((item) => (
          <div key={item.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium text-foreground">{item.action}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{item.poolName}</p>
              </div>
              <p className="text-xs text-muted-foreground sm:text-sm">{item.time}</p>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-foreground">{item.value}</span>
              <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-xs text-muted-foreground">
                {item.privacy}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------- Small components ---------------- */

function MetricCard({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Shield }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-soft">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <p className="mt-2 text-lg font-semibold text-foreground sm:text-xl">{value}</p>
    </div>
  );
}

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

function ModeButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3.5 py-1.5 text-xs transition-colors duration-200 sm:text-sm ${
        active ? "border-primary/40 bg-surface-elevated text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
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

function RangeBand({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/50 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function OutcomeRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/80 pb-3 last:border-b-0 last:pb-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}
