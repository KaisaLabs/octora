import type { PnLSummary } from "@/lib/pnl";

interface Props {
  summary: PnLSummary;
  positionCount: number;
  poolCount: number;
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

export function PortfolioStatsPanel({ summary, positionCount, poolCount }: Props) {
  const positive = summary.totalPnL >= 0;
  const currentPlusPending = summary.totalPositionValue + summary.claimableFees;

  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <p className="font-display text-base font-semibold tracking-tight text-foreground">
          Active Positions Summary
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {positionCount} position{positionCount === 1 ? "" : "s"} · {poolCount} pool
          {poolCount === 1 ? "" : "s"}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-y border-border/60 py-4 text-sm">
        <Row label="Total Deposited" value={fmtUsd(summary.totalDeposited)} />
        <Row label="Current Position" value={fmtUsd(summary.totalPositionValue)} />
        <Row label="Fees Claimed" value={fmtUsd(summary.feesClaimed)} />
        <Row
          label="Pending Fees"
          value={fmtUsd(summary.claimableFees)}
          accent={summary.claimableFees > 0}
        />
        <Row label="Avg Invested" value={fmtUsd(summary.avgInvested)} />
        <Row label="Current + Pending" value={fmtUsd(currentPlusPending)} />
      </div>

      <div
        className={`rounded-xl border px-4 py-3 ${
          positive
            ? "border-primary/30 bg-primary/[0.06]"
            : "border-destructive/30 bg-destructive/[0.06]"
        }`}
      >
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">P&L</p>
          <span
            className={`rounded-full border px-2 py-0.5 font-mono text-[11px] tabular-nums ${
              positive
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-destructive/30 bg-destructive/10 text-destructive"
            }`}
          >
            {signedPct(summary.totalPnLPct)}
          </span>
        </div>
        <p
          className={`mt-1 font-display text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl ${
            positive ? "text-primary" : "text-destructive"
          }`}
        >
          {signedUsd(summary.totalPnL)}
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
