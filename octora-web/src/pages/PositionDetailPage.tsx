import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Coins, Copy, Minus, Plus, Repeat } from "lucide-react";

import type { DistributionShape, LiquidityBin, PortfolioPosition } from "@/components/octora/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BinLiquidityChart } from "@/components/octora/lp/BinLiquidityChart";
import { DistributionPreset } from "@/components/octora/lp/DistributionPreset";
import { PositionStatusPill } from "@/components/octora/lp/PositionStatusPill";
import { PnLBreakdownChart } from "@/components/octora/lp/PnLBreakdownChart";
import { Reveal } from "@/components/octora/lp/Reveal";
import { projectUserShape } from "@/lib/bins";
import { generatePositionPnLSeries } from "@/lib/pnl";

interface Props {
  positions: PortfolioPosition[];
}

const parseUsd = (v: string | undefined): number => {
  if (!v) return 0;
  const n = parseFloat(v.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

function buildPositionBins(p: PortfolioPosition): LiquidityBin[] {
  const center = p.activeBinId ?? 0;
  const lower = p.rangeLowerBin ?? center - 8;
  const upper = p.rangeUpperBin ?? center + 8;
  const halfSpan = Math.max(28, Math.max(Math.abs(lower - center), Math.abs(upper - center)) + 12);
  const count = halfSpan * 2 + 1;
  return Array.from({ length: count }, (_, i) => {
    const binId = center - halfSpan + i;
    const d = binId - center;
    const sigma = halfSpan / 2.8;
    const liquidity = Math.exp(-(d * d) / (2 * sigma * sigma)) * 1_000_000;
    return { binId, price: 1 + binId * 0.005, liquidity };
  });
}

export function PositionDetailPage({ positions }: Props) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const position = positions.find((p) => p.id === id);

  const bins = useMemo(() => (position ? buildPositionBins(position) : []), [position]);
  const center = position?.activeBinId ?? 0;
  const lower = position?.rangeLowerBin ?? center - 8;
  const upper = position?.rangeUpperBin ?? center + 8;
  const userOverlay = useMemo(
    () =>
      position && bins.length > 0
        ? projectUserShape(bins, lower, upper, position.shape ?? "spot", parseUsd(position.value) || 1)
        : [],
    [bins, lower, upper, position],
  );

  const series = useMemo(() => {
    if (!position) return [];
    return generatePositionPnLSeries({
      notionalUsd: parseUsd(position.deposited),
      apr: parseFloat(position.apr.replace("%", "")) || 20,
      seed: hashSeed(position.id),
    });
  }, [position]);

  if (!position) {
    return (
      <section className="panel-shell rounded-2xl p-8 text-center">
        <p className="text-sm text-muted-foreground">Position not found.</p>
        <Link to="/portfolio" className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to portfolio
        </Link>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      {/* Top bar */}
      <button
        type="button"
        onClick={() => navigate("/portfolio")}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to portfolio
      </button>

      {/* Header */}
      <Reveal delay={0}>
      <section className="panel-shell rounded-2xl p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                {position.protocol}
              </span>
              <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Bin step {position.binStep ?? "—"}
              </span>
              <span className="rounded-full border border-border bg-secondary/70 px-2.5 py-1 text-[11px] text-muted-foreground">
                Opened {position.openedAt ?? "—"}
              </span>
              <PositionStatusPill inRange={position.inRange} size="sm" />
            </div>

            <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              {position.poolName}
            </h1>

            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="font-mono text-xs">{position.id}</span>
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(position.id)}
                className="inline-flex items-center gap-1 text-foreground transition-colors hover:text-primary"
              >
                <Copy className="h-3.5 w-3.5" /> Copy
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:w-[560px]">
            <Stat label="Value" value={position.value} />
            <Stat label="Deposited" value={position.deposited} muted />
            <Stat label="P&L" value={position.pnl ?? "—"} tone={position.pnlDirection === "down" ? "down" : "up"} />
            <Stat label="Fees" value={position.feesEarned} tone="up" />
          </div>
        </div>
      </section>
      </Reveal>

      {/* Bin chart + claim summary */}
      <Reveal delay={80}>
      <section className="panel-shell rounded-2xl p-5 sm:p-6">
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <div className="rounded-2xl border border-border/70 bg-card/60 p-3 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-baseline gap-3">
                <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Your liquidity</span>
                <span className="font-mono text-sm text-muted-foreground">
                  {bins[0]?.binId} → {bins.at(-1)?.binId}
                </span>
              </div>
              <span className="rounded-full border border-border bg-secondary/60 px-2.5 py-1 font-mono text-xs text-muted-foreground">
                {Math.max(0, upper - lower + 1)} bins
              </span>
            </div>

            <BinLiquidityChart
              bins={bins}
              activeBinId={center}
              range={{ lower, upper }}
              shape={position.shape ?? "spot"}
              userLiquidity={userOverlay}
              height={260}
            />
          </div>

          <ClaimSummary position={position} />
        </div>
      </section>
      </Reveal>

      {/* P&L breakdown */}
      <Reveal delay={160}>
        <PnLBreakdownChart series={series} totalHours={series.length - 1} />
      </Reveal>

      {/* Action drawer */}
      <Reveal delay={240}>
        <ActionDrawer position={position} bins={bins} initialLower={lower} initialUpper={upper} center={center} />
      </Reveal>
    </div>
  );
}

function ClaimSummary({ position }: { position: PortfolioPosition }) {
  const claimable = parseUsd(position.claimable);
  return (
    <div className="flex flex-col justify-between gap-4 rounded-2xl border border-border bg-card p-5">
      <div>
        <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Earnings</p>
        <p className="mt-2 font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {position.feesEarned}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Total fees since opening</p>
      </div>

      <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
        <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Claimable now</p>
        <p
          className={`mt-1 font-mono text-xl font-semibold tabular-nums ${
            claimable > 0 ? "text-primary" : "text-foreground/70"
          }`}
        >
          {position.claimable ?? "$0.00"}
        </p>
        <Button
          variant="hero"
          size="sm"
          disabled={claimable <= 0}
          className="mt-3 w-full justify-center rounded-xl"
        >
          <Coins className="h-4 w-4" />
          Claim privately
        </Button>
      </div>

      <p className="text-[11px] leading-5 text-muted-foreground">
        Claims settle to your session wallet, then forward through the private route to your funding address.
      </p>
    </div>
  );
}

function ActionDrawer({
  position,
  bins,
  initialLower,
  initialUpper,
  center,
}: {
  position: PortfolioPosition;
  bins: LiquidityBin[];
  initialLower: number;
  initialUpper: number;
  center: number;
}) {
  const [tab, setTab] = useState("rebalance");

  return (
    <section className="panel-shell rounded-2xl p-5 sm:p-6">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto w-full justify-start overflow-x-auto rounded-lg border border-border bg-secondary/60 p-1 sm:w-auto">
          <TabsTrigger value="add" className="rounded-md px-4 py-2 text-sm data-[state=active]:bg-surface-elevated">
            <Plus className="h-3.5 w-3.5" />
            Add liquidity
          </TabsTrigger>
          <TabsTrigger value="withdraw" className="rounded-md px-4 py-2 text-sm data-[state=active]:bg-surface-elevated">
            <Minus className="h-3.5 w-3.5" />
            Withdraw
          </TabsTrigger>
          <TabsTrigger value="rebalance" className="rounded-md px-4 py-2 text-sm data-[state=active]:bg-surface-elevated">
            <Repeat className="h-3.5 w-3.5" />
            Rebalance
          </TabsTrigger>
        </TabsList>

        <TabsContent value="add" className="mt-5">
          <AddLiquidityPanel position={position} />
        </TabsContent>
        <TabsContent value="withdraw" className="mt-5">
          <WithdrawPanel position={position} />
        </TabsContent>
        <TabsContent value="rebalance" className="mt-5">
          <RebalancePanel
            position={position}
            bins={bins}
            initialLower={initialLower}
            initialUpper={initialUpper}
            center={center}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}

function AddLiquidityPanel({ position }: { position: PortfolioPosition }) {
  const [usd, setUsd] = useState(1000);
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Top up existing range</p>
        <Input
          type="number"
          min={50}
          step={50}
          value={usd}
          onChange={(e) => setUsd(Number(e.target.value))}
          className="h-12 rounded-xl border-border bg-background font-mono text-base tabular-nums"
        />
        <div className="flex flex-wrap gap-2">
          {[100, 500, 1000, 5000].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setUsd(v)}
              className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              ${v.toLocaleString()}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Your existing distribution ({position.shape ?? "spot"}) and range stay the same.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-5">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Summary</p>
        <Row label="Amount" value={`$${usd.toLocaleString()}`} />
        <Row label="Position after" value={`$${(parseUsd(position.value) + usd).toLocaleString()}`} />
        <Row label="Execution" value="Private relay" />
        <Button variant="hero" size="lg" className="mt-4 w-full justify-center rounded-xl">
          Add privately
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

function WithdrawPanel({ position }: { position: PortfolioPosition }) {
  const [pct, setPct] = useState(50);
  const value = parseUsd(position.value);
  const withdrawValue = (value * pct) / 100;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Withdraw amount</p>
          <p className="font-mono text-sm font-medium tabular-nums text-foreground">{pct}%</p>
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
        <Stat label="Receive" value={`$${withdrawValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
        <Stat label="Remaining" value={`$${(value - withdrawValue).toLocaleString(undefined, { maximumFractionDigits: 2 })}`} muted />
        <Stat label="Execution" value="Private route" muted />
      </div>

      <Button variant="hero" size="lg" className="w-full justify-center rounded-xl">
        Withdraw privately
        <ArrowRight />
      </Button>
      <p className="text-xs leading-5 text-muted-foreground">
        Funds return through the private route — your main wallet stays hidden from on-chain observers.
      </p>
    </div>
  );
}

function RebalancePanel({
  position,
  bins,
  initialLower,
  initialUpper,
  center,
}: {
  position: PortfolioPosition;
  bins: LiquidityBin[];
  initialLower: number;
  initialUpper: number;
  center: number;
}) {
  const [range, setRange] = useState({ lower: initialLower, upper: initialUpper });
  const [shape, setShape] = useState<DistributionShape>(position.shape ?? "spot");

  // If position drifted out of range, propose recentering on active bin by default.
  useEffect(() => {
    if (position.inRange === false) {
      const span = Math.max(8, initialUpper - initialLower);
      setRange({ lower: center - Math.floor(span / 2), upper: center + Math.ceil(span / 2) });
    }
  }, [position.inRange, center, initialLower, initialUpper]);

  const value = parseUsd(position.value);
  const overlay = useMemo(() => projectUserShape(bins, range.lower, range.upper, shape, value || 1), [
    bins,
    range,
    shape,
    value,
  ]);

  const movedLower = range.lower !== initialLower;
  const movedUpper = range.upper !== initialUpper;
  const reshape = shape !== (position.shape ?? "spot");
  const dirty = movedLower || movedUpper || reshape;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">New range</p>
            <p className="mt-1 font-display text-lg font-semibold tracking-tight text-foreground">
              Drag the handles to redraw your range
            </p>
          </div>
          {position.inRange === false && (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-400">
              Recenter suggested
            </span>
          )}
        </div>

        <BinLiquidityChart
          bins={bins}
          activeBinId={center}
          range={range}
          shape={shape}
          userLiquidity={overlay}
          onRangeChange={setRange}
          height={220}
        />

        <div className="mt-4">
          <p className="mb-2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Distribution</p>
          <DistributionPreset value={shape} onChange={setShape} />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">What changes</p>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            <Diff
              label="Lower bin"
              before={String(initialLower)}
              after={String(range.lower)}
              changed={movedLower}
            />
            <Diff
              label="Upper bin"
              before={String(initialUpper)}
              after={String(range.upper)}
              changed={movedUpper}
            />
            <Diff
              label="Shape"
              before={position.shape ?? "spot"}
              after={shape}
              changed={reshape}
            />
            <Diff
              label="Bins covered"
              before={String(initialUpper - initialLower + 1)}
              after={String(range.upper - range.lower + 1)}
              changed={range.upper - range.lower !== initialUpper - initialLower}
            />
          </ul>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Bundle</p>
          <p className="mt-2 text-sm leading-6 text-foreground">
            Withdraw from the old range and redeposit into the new one — settled as a single private bundle so the
            position never appears uncovered to observers.
          </p>
          <Row label="Notional" value={position.value} />
          <Row label="Execution" value="Single private bundle" />
          <Button
            variant="hero"
            size="lg"
            disabled={!dirty}
            className="mt-3 w-full justify-center rounded-xl"
          >
            Rebalance privately
            <ArrowRight />
          </Button>
          {!dirty && (
            <p className="mt-2 text-[11px] text-muted-foreground">No changes yet — drag a handle or pick a different shape.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Diff({ label, before, after, changed }: { label: string; before: string; after: string; changed: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3 border-b border-border/70 pb-2 last:border-b-0 last:pb-0">
      <span className="text-sm">{label}</span>
      <span className="flex items-center gap-2 font-mono text-xs tabular-nums">
        <span className="text-muted-foreground line-through">{before}</span>
        <ArrowRight className="h-3 w-3 text-muted-foreground" />
        <span className={changed ? "text-primary" : "text-foreground"}>{after}</span>
      </span>
    </li>
  );
}

function Stat({
  label,
  value,
  tone,
  muted,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
  muted?: boolean;
}) {
  const color =
    tone === "up"
      ? "text-primary"
      : tone === "down"
      ? "text-destructive"
      : muted
      ? "text-muted-foreground"
      : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
      <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground sm:text-xs">{label}</p>
      <p className={`mt-1.5 font-mono text-base font-semibold tabular-nums sm:text-lg ${color}`}>{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-3 flex items-center justify-between gap-3 border-b border-border/80 pb-3 last:border-b-0 last:pb-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-mono text-sm font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}
