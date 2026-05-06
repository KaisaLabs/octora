import { useMemo, useState } from "react";
import type { PortfolioPosition } from "@/components/octora/types";
import { Button } from "@/components/ui/button";
import { PositionCard } from "@/components/octora/lp/PositionCard";
import { PnLCalendar } from "@/components/octora/lp/PnLCalendar";
import { PortfolioStatsPanel } from "@/components/octora/lp/PortfolioStatsPanel";
import { generateDailyPnL, summarizePnL } from "@/lib/pnl";

interface PortfolioPageProps {
  positions: PortfolioPosition[];
}

type Filter = "all" | "in-range" | "out-of-range" | "claimable";

const parseUsd = (v: string | undefined): number => {
  if (!v) return 0;
  const n = parseFloat(v.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

export function PortfolioPage({ positions }: PortfolioPageProps) {
  const [filter, setFilter] = useState<Filter>("all");

  const totals = useMemo(() => {
    const value = positions.reduce((s, p) => s + parseUsd(p.value), 0);
    const fees = positions.reduce((s, p) => s + parseUsd(p.feesEarned), 0);
    const deposited = positions.reduce((s, p) => s + parseUsd(p.deposited), 0);
    const claimable = positions.reduce((s, p) => s + parseUsd(p.claimable), 0);
    const inRange = positions.filter((p) => p.inRange).length;
    return { value, fees, deposited, claimable, inRange };
  }, [positions]);

  const today = useMemo(() => new Date(), []);
  const daily = useMemo(() => {
    const since = new Date(today);
    since.setDate(today.getDate() - 60);
    return generateDailyPnL({ since, until: today, dailyMeanUsd: Math.max(8, totals.deposited * 0.0008) });
  }, [today, totals.deposited]);

  const summary = useMemo(
    () =>
      summarizePnL(daily, {
        totalDeposited: totals.deposited,
        totalPositionValue: totals.value,
        feesClaimed: totals.fees,
        claimableFees: totals.claimable,
      }),
    [daily, totals],
  );

  const filtered = useMemo(() => {
    return positions.filter((p) => {
      if (filter === "in-range") return p.inRange === true;
      if (filter === "out-of-range") return p.inRange === false;
      if (filter === "claimable") return parseUsd(p.claimable) > 0;
      return true;
    });
  }, [positions, filter]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Portfolio</p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Your private LP
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {positions.length} position{positions.length === 1 ? "" : "s"} ·{" "}
            <span className={totals.inRange === positions.length ? "text-primary" : "text-amber-400"}>
              {totals.inRange}/{positions.length} in range
            </span>
          </p>
        </div>

        {totals.claimable > 0 && (
          <div className="flex items-center gap-3 rounded-full border border-primary/30 bg-primary/5 px-4 py-2">
            <span className="text-xs text-muted-foreground">Claimable</span>
            <span className="font-mono text-sm font-semibold tabular-nums text-primary">
              ${totals.claimable.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
            <Button variant="hero" size="sm" className="rounded-full">
              Claim all
            </Button>
          </div>
        )}
      </section>

      {/* Stats + calendar */}
      <section className="panel-shell rounded-2xl p-5 sm:p-6">
        <div className="grid gap-6 lg:grid-cols-[minmax(280px,1fr)_2fr]">
          <div className="border-b border-border/60 pb-6 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-6">
            <PortfolioStatsPanel summary={summary} />
          </div>
          <div className="min-h-[420px]">
            <PnLCalendar daily={daily} today={today} />
          </div>
        </div>
      </section>

      {/* Filters + positions */}
      <section className="panel-shell rounded-2xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Filter</span>
          <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
            All ({positions.length})
          </FilterChip>
          <FilterChip active={filter === "in-range"} onClick={() => setFilter("in-range")}>
            In range
          </FilterChip>
          <FilterChip active={filter === "out-of-range"} onClick={() => setFilter("out-of-range")}>
            Out of range
          </FilterChip>
          <FilterChip active={filter === "claimable"} onClick={() => setFilter("claimable")}>
            Has fees
          </FilterChip>
        </div>

        {filtered.length === 0 ? (
          <div className="mt-6 rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
            No positions match this filter.
          </div>
        ) : (
          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((p) => (
              <PositionCard key={p.id} position={p} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
        active
          ? "border-primary/40 bg-surface-elevated text-foreground"
          : "border-border bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
