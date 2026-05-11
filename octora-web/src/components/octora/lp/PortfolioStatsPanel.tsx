import type { OverviewMetrics } from "@/lib/pnl";

interface Props {
  metrics: OverviewMetrics;
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

export function PortfolioStatsPanel({ metrics }: Props) {
  const hasDeposits = metrics.totalDeposited > 0;
  const positive = metrics.totalPnL >= 0;

  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <p className="font-display text-base font-semibold tracking-tight text-foreground">
          Active Positions Summary
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {metrics.livePositionCount} active position
          {metrics.livePositionCount === 1 ? "" : "s"} · {metrics.poolCount} pool
          {metrics.poolCount === 1 ? "" : "s"}
          {metrics.closedPositionCount > 0
            ? ` · ${metrics.closedPositionCount} closed`
            : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-y border-border/60 py-4 text-sm">
        <Row label="Total Deposited" value={fmtUsd(metrics.totalDeposited)} />
        <Row label="Current Value" value={fmtUsd(metrics.totalPositionValue)} />
        <Row
          label="Pending Fees"
          value={fmtUsd(metrics.pendingFeesUsd)}
          accent={metrics.pendingFeesUsd > 0}
        />
        <Row
          label="Positions with fees"
          value={
            metrics.positionsWithClaimableFees > 0
              ? `${metrics.positionsWithClaimableFees} / ${metrics.livePositionCount}`
              : "—"
          }
        />
      </div>

      <div
        className={`rounded-xl border px-4 py-3 ${
          !hasDeposits
            ? "border-border/60 bg-card/40"
            : positive
              ? "border-primary/30 bg-primary/[0.06]"
              : "border-destructive/30 bg-destructive/[0.06]"
        }`}
      >
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Net P&L</p>
          {hasDeposits && (
            <span
              className={`rounded-full border px-2 py-0.5 font-mono text-[11px] tabular-nums ${
                positive
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-destructive/30 bg-destructive/10 text-destructive"
              }`}
            >
              {signedPct(metrics.totalPnLPct)}
            </span>
          )}
        </div>
        <p
          className={`mt-1 font-display text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl ${
            !hasDeposits
              ? "text-muted-foreground"
              : positive
                ? "text-primary"
                : "text-destructive"
          }`}
        >
          {hasDeposits ? signedUsd(metrics.totalPnL) : "—"}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {hasDeposits
            ? "Current Value + Pending Fees − Total Deposited. Realised fees from prior claims aren't tracked yet."
            : "Open a position to start tracking P&L."}
        </p>
      </div>
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`font-mono text-sm font-medium tabular-nums ${
          accent ? "text-primary" : "text-foreground"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
