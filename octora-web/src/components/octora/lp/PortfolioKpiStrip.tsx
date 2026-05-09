import { Coins, Target, TrendingUp, Trophy } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PnLSummary } from "@/lib/pnl";

interface Props {
  summary: PnLSummary;
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `$${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function signedUsd(n: number): string {
  if (n === 0) return fmtUsd(0);
  return n > 0 ? `+${fmtUsd(n)}` : `−${fmtUsd(Math.abs(n))}`;
}

function signedPct(n: number): string {
  if (n === 0) return "0.00%";
  const s = n > 0 ? "+" : "−";
  return `${s}${Math.abs(n).toFixed(2)}%`;
}

export function PortfolioKpiStrip({ summary }: Props) {
  const pnlPositive = summary.totalPnL >= 0;
  const winPositive = summary.winRate >= 50;

  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        icon={TrendingUp}
        label="Net P&L"
        value={signedUsd(summary.totalPnL)}
        sub={signedPct(summary.totalPnLPct)}
        tone={pnlPositive ? "up" : "down"}
      />
      <KpiCard
        icon={Target}
        label="Win Rate"
        value={`${summary.winRate.toFixed(1)}%`}
        sub="of trading days"
        tone={winPositive ? "up" : "neutral"}
      />
      <KpiCard
        icon={Trophy}
        label="Biggest Win"
        value={signedUsd(summary.biggestWinUsd)}
        sub={signedPct(summary.biggestWinPct)}
        tone="up"
      />
      <KpiCard
        icon={Coins}
        label="Claimable"
        value={fmtUsd(summary.claimableFees)}
        sub={summary.claimableFees > 0 ? "ready to claim" : "no pending fees"}
        tone={summary.claimableFees > 0 ? "up" : "neutral"}
      />
    </section>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
  tone: "up" | "down" | "neutral";
}) {
  const valueColor =
    tone === "up" ? "text-primary" : tone === "down" ? "text-destructive" : "text-foreground";
  const iconColor =
    tone === "up"
      ? "bg-primary/10 text-primary"
      : tone === "down"
        ? "bg-destructive/10 text-destructive"
        : "bg-surface-elevated text-muted-foreground";

  return (
    <div className="panel-shell flex items-start gap-3 rounded-2xl p-4">
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${iconColor}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
        <p className={`mt-1 font-display text-xl font-semibold tracking-tight tabular-nums sm:text-2xl ${valueColor}`}>
          {value}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</p>
      </div>
    </div>
  );
}
