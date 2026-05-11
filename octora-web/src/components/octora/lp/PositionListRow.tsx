import { useNavigate } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import type { PortfolioPosition } from "@/components/octora/types";

interface Props {
  position: PortfolioPosition;
  /** Override the click target. Defaults to navigating to the position detail page. */
  onOpen?: () => void;
}

/** Slim one-line variant of PositionCard for the closed-positions list view.
 *  Drops the bin chart and claim CTA — closed positions can't accrue fees or
 *  be managed any further, only inspected. */
export function PositionListRow({ position, onOpen }: Props) {
  const navigate = useNavigate();
  const handleOpen = onOpen ?? (() => navigate(`/position/${position.id}`));
  const pnlColor =
    position.pnlDirection === "down"
      ? "text-destructive"
      : position.pnlDirection === "up"
        ? "text-primary"
        : "text-foreground";

  return (
    <button
      type="button"
      onClick={handleOpen}
      className="group relative grid w-full grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))_auto] items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary/30 hover:bg-surface-elevated"
    >
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-[2px] rounded-l-xl bg-muted-foreground/40"
      />

      <div className="min-w-0">
        <p className="truncate font-medium text-foreground">{position.poolName}</p>
        <p className="mt-0.5 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          {position.protocol} · {position.openedAt ?? "—"}
        </p>
      </div>

      <ListStat label="Deposited" value={position.deposited} />
      <ListStat label="Final value" value={position.value} />
      <ListStat label="Fees" value={position.feesEarned} tone="primary" />
      <ListStat label="P&L" value={position.pnl ?? "—"} className={pnlColor} />

      <ArrowUpRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
    </button>
  );
}

function ListStat({
  label,
  value,
  tone,
  className,
}: {
  label: string;
  value: string;
  tone?: "primary";
  className?: string;
}) {
  const color = className ?? (tone === "primary" ? "text-primary" : "text-foreground");
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className={`mt-0.5 truncate font-mono text-sm tabular-nums ${color}`}>{value}</p>
    </div>
  );
}
