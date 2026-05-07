import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Coins, Copy, Flame, Minus } from "lucide-react";

import type { DistributionShape, Pool } from "@/components/octora/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BinLiquidityChart } from "@/components/octora/lp/BinLiquidityChart";
import { DistributionPreset } from "@/components/octora/lp/DistributionPreset";
import { PositionStatusPill } from "@/components/octora/lp/PositionStatusPill";
import { usePoolBins } from "@/hooks/usePoolBins";

interface Props {
  pool: Pool;
  presetShape?: DistributionShape;
  onBack: () => void;
}

export function PoolDetailView({ pool, presetShape, onBack }: Props) {
  const [detailTab, setDetailTab] = useState("deposit");

  return (
    <div className="space-y-5">
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
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(pool.address)}
                className="inline-flex items-center gap-1 text-foreground transition-colors hover:text-primary"
              >
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

function DepositPanel({ pool, presetShape }: { pool: Pool; presetShape?: DistributionShape }) {
  const { bins, activeBinId, isLoading: binsLoading, isFallback } = usePoolBins(pool, 61);

  const [depositUsd, setDepositUsd] = useState(2500);
  const [shape, setShape] = useState<DistributionShape>(presetShape ?? "curve");

  useEffect(() => {
    if (presetShape) setShape(presetShape);
  }, [presetShape]);

  const [range, setRange] = useState<{ lower: number; upper: number }>(() => ({
    lower: activeBinId - 8,
    upper: activeBinId + 8,
  }));

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

      <div className="rounded-2xl border border-border/70 bg-card/60 p-3 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Active price</span>
            <span className="font-mono text-base text-foreground tabular-nums">{formatPrice(activePrice)}</span>
            <span className="text-xs text-muted-foreground">
              {pool.tokenA}/{pool.tokenB}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <BinSourceBadge loading={binsLoading} fallback={isFallback} />
            <PositionStatusPill inRange size="sm" label="Active in range" />
          </div>
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
            <OutcomeRow label="Capital efficiency" value={`${projection.concentration.toFixed(1)}x`} accent />
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
                pct === v
                  ? "border-primary/40 bg-surface-elevated text-foreground"
                  : "border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {v}%
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <ClaimTile label="Receive" value={`$${withdrawValue.toFixed(0)}`} sub="Estimated value" />
        <ClaimTile
          label={pool.tokenA}
          value={`${((withdrawValue * pool.allocation.tokenA) / 100).toFixed(2)}`}
          sub="Tokens"
        />
        <ClaimTile
          label={pool.tokenB}
          value={`${((withdrawValue * pool.allocation.tokenB) / 100).toFixed(2)}`}
          sub="Tokens"
        />
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
      <p
        className={`mt-0.5 text-[11px] tabular-nums ${
          center ? "text-amber-400" : pct >= 0 ? "text-primary" : "text-muted-foreground"
        }`}
      >
        {center ? "Mid price" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
      </p>
    </div>
  );
}

function PoolInfoStat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
      <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground sm:text-xs">{label}</p>
      <p className={`mt-1.5 text-base font-semibold sm:text-lg ${highlight ? "text-primary" : "text-foreground"}`}>
        {value}
      </p>
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

function BinSourceBadge({ loading, fallback }: { loading: boolean; fallback: boolean }) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
        Loading bins
      </span>
    );
  }
  if (fallback) {
    return (
      <span
        title="Live bin data unavailable; showing modeled distribution."
        className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-amber-300"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        Modeled
      </span>
    );
  }
  return (
    <span
      title="Live bin liquidity from on-chain DLMM."
      className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-primary"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_6px_hsl(160_84%_55%)]" />
      On-chain
    </span>
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
