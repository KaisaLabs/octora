import type { PortfolioPosition } from "@/components/octora/types";

interface Props {
  position: PortfolioPosition;
}

/**
 * Truthful P&L snapshot for the position-detail page.
 *
 * The MVP indexer doesn't expose per-position history, so we don't fake a
 * time-series chart. We render the three numbers we actually know:
 *   - Fees earned  = feesEarned (claimable + claimed, USD)
 *   - Market P&L   = value − deposited (LP-value drift, excluding fees)
 *   - Net P&L      = value + feesEarned − deposited = the existing `pnl` field
 *
 * `Net P&L = Fees + Market P&L` by construction (see usePortfolioPositions.ts).
 */
export function PnLBreakdownPanel({ position }: Props) {
  // Use raw numeric USD amounts from the indexer — never re-parse the
  // display strings, since `toLocaleString` formats with comma-decimals in
  // many locales (e.g. "$96,18") and parseFloat would mangle them.
  const deposited = position.depositedUsd ?? 0;
  const value = position.valueUsd ?? 0;
  const fees = position.feesUsd ?? 0;
  const marketPnl = value - deposited;
  const netPnl = marketPnl + fees;

  return (
    <section className="panel-shell rounded-2xl p-5 sm:p-6">
      <div className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
          P&amp;L breakdown
        </p>
        <p className="mt-1.5 font-display text-2xl font-semibold tracking-tight sm:text-3xl">
          <span className={toneClass(netPnl)}>{signedUsd(netPnl)}</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Snapshot since opening. Hour-by-hour history will surface once the
          indexer ships per-position data.
        </p>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card label="Fees earned" value={signedUsd(fees)} tone={fees > 0 ? "up" : "neutral"} />
        <Card
          label="Market P&L"
          value={signedUsd(marketPnl)}
          tone={marketPnl > 0.005 ? "up" : marketPnl < -0.005 ? "down" : "neutral"}
          hint="value − deposited"
        />
        <Card
          label="Open since"
          value={position.openedAt ?? "—"}
          tone="neutral"
          mono={false}
        />
      </div>
    </section>
  );
}

function Card({
  label,
  value,
  tone,
  hint,
  mono = true,
}: {
  label: string;
  value: string;
  tone: "up" | "down" | "neutral";
  hint?: string;
  mono?: boolean;
}) {
  const dot =
    tone === "up"
      ? "bg-primary shadow-[0_0_6px_hsl(160_84%_55%)]"
      : tone === "down"
        ? "bg-destructive"
        : "bg-muted-foreground/40";
  const valueColor = toneClass(tone === "up" ? 1 : tone === "down" ? -1 : 0);
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {label}
      </div>
      <p
        className={
          mono
            ? `font-mono text-sm font-medium tabular-nums ${valueColor}`
            : `text-sm font-medium ${valueColor}`
        }
      >
        {value}
      </p>
      {hint && (
        <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-muted-foreground/70">
          {hint}
        </p>
      )}
    </div>
  );
}

function signedUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) < 0.005) return "$0.00";
  const abs = Math.abs(n);
  const txt =
    abs >= 1_000_000
      ? `$${(abs / 1_000_000).toFixed(2)}M`
      : abs >= 10_000
        ? `$${(abs / 1000).toFixed(1)}K`
        : `$${abs.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return n > 0 ? `+${txt}` : `−${txt}`;
}

function toneClass(n: number): string {
  if (n > 0.005) return "text-primary";
  if (n < -0.005) return "text-destructive";
  return "text-foreground/70";
}
