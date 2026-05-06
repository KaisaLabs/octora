import { useMemo, useState } from "react";
import { Coins, Wallet } from "lucide-react";
import type { PortfolioPosition } from "@/components/octora/types";
import { Button } from "@/components/ui/button";
import { PositionCard } from "@/components/octora/lp/PositionCard";

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
    const pnl = positions.reduce((s, p) => s + parseUsd(p.pnl), 0);
    const claimable = positions.reduce((s, p) => s + parseUsd(p.claimable), 0);
    const inRange = positions.filter((p) => p.inRange).length;
    return { value, fees, pnl, claimable, inRange };
  }, [positions]);

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
      {/* Summary */}
      <section className="panel-shell rounded-2xl p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
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

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryStat icon={<Wallet className="h-3.5 w-3.5" />} label="Total value" value={fmtUsd(totals.value)} />
            <SummaryStat label="Unrealized P&L" value={fmtSigned(totals.pnl)} tone={totals.pnl >= 0 ? "up" : "down"} />
            <SummaryStat label="Fees earned" value={fmtUsd(totals.fees)} tone="up" />
            <SummaryStat
              icon={<Coins className="h-3.5 w-3.5" />}
              label="Claimable"
              value={fmtUsd(totals.claimable)}
              tone="up"
            />
          </div>
        </div>

        {totals.claimable > 0 && (
          <div className="mt-5 flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              <span className="font-mono font-semibold tabular-nums text-primary">
                {fmtUsd(totals.claimable)}
              </span>{" "}
              <span className="text-muted-foreground">
                ready across {positions.filter((p) => parseUsd(p.claimable) > 0).length} position
                {positions.filter((p) => parseUsd(p.claimable) > 0).length === 1 ? "" : "s"}
              </span>
            </div>
            <Button variant="hero" size="sm" className="rounded-full">
              Claim all privately
            </Button>
          </div>
        )}
      </section>

      {/* Filters */}
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

function SummaryStat({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
  icon?: React.ReactNode;
}) {
  const color = tone === "up" ? "text-primary" : tone === "down" ? "text-destructive" : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
      <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className={`mt-1.5 font-mono text-base font-semibold tabular-nums sm:text-lg ${color}`}>{value}</p>
    </div>
  );
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtSigned(n: number): string {
  const sign = n >= 0 ? "+" : "−";
  return `${sign}${fmtUsd(Math.abs(n)).replace("$", "$")}`;
}
