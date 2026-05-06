import { Clock } from "lucide-react";
import type { PnLSummary } from "@/lib/pnl";

interface Props {
  summary: PnLSummary;
  unit?: "USD" | "SOL";
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

export function PortfolioStatsPanel({ summary }: Props) {
  const positive = summary.totalPnL >= 0;

  return (
    <div className="flex h-full flex-col justify-between gap-8">
      {/* Position value */}
      <div>
        <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Total Position Value</p>
        <p className="mt-2 font-display text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
          {fmtUsd(summary.totalPositionValue)}
        </p>

        <div className="mt-6 grid grid-cols-3 gap-4">
          <MiniStat label="All-time Deposit" value={fmtUsd(summary.totalDeposited)} />
          <MiniStat label="Fees Claimed" value={fmtUsd(summary.feesClaimed)} />
          <MiniStat label="Claimable Fees" value={fmtUsd(summary.claimableFees)} accent={summary.claimableFees > 0} />
        </div>
      </div>

      {/* Total PnL */}
      <div>
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Total PnL</p>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/40 px-2.5 py-1 text-[11px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            30D
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-baseline gap-3">
          <p
            className={`font-display text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl ${
              positive ? "text-primary" : "text-destructive"
            }`}
          >
            {signedUsd(summary.totalPnL)}
          </p>
          <span
            className={`rounded-full border px-2.5 py-1 font-mono text-xs tabular-nums ${
              positive
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-destructive/30 bg-destructive/10 text-destructive"
            }`}
          >
            {signedPct(summary.totalPnLPct)}
          </span>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-4">
          <MiniStat label="Avg Invested" value={fmtUsd(summary.avgInvested)} />
          <MiniStat label="Win Rate" value={`${summary.winRate.toFixed(2)}%`} />
          <MiniStat
            label="Biggest Win"
            value={`${signedUsd(summary.biggestWinUsd)} (${signedPct(summary.biggestWinPct)})`}
            accent
          />
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className={`mt-1.5 font-mono text-sm font-medium tabular-nums sm:text-base ${accent ? "text-primary" : "text-foreground"}`}>
        {value}
      </p>
    </div>
  );
}
