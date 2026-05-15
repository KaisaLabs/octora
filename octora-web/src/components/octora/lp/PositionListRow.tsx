import { useNavigate } from "react-router-dom";
import { ArrowUpRight, Coins, PlayCircle, Repeat, Settings2 } from "lucide-react";
import type { PortfolioPosition } from "@/components/octora/types";
import { Button } from "@/components/ui/button";
import { useCanClosePosition } from "@/hooks/useCanClosePosition";
import { PositionStatusPill } from "./PositionStatusPill";

interface Props {
  position: PortfolioPosition;
  /** Override the row click target. Defaults to navigating to the position
   *  detail page. Closed-position rows are click-only; active rows expose
   *  separate Claim/Manage buttons that stop event propagation. */
  onOpen?: () => void;
  /** Only meaningful for active positions — shown as a Claim button when
   *  provided. Closed-position rows ignore this. */
  onClaim?: () => void;
}

/** Slim one-line variant of PositionCard for portfolio list views.
 *
 *  Two layouts share the same row shell so Active and Closed tabs feel
 *  consistent:
 *   - Active: status pill, Value, P&L, Fees, Claimable, [Claim][Manage]
 *   - Closed: Deposited, Final value, Fees, P&L, navigate-arrow
 */
export function PositionListRow({ position, onOpen, onClaim }: Props) {
  const navigate = useNavigate();
  const handleOpen = onOpen ?? (() => navigate(`/position/${position.id}`));
  const pnlColor =
    position.pnlDirection === "down"
      ? "text-destructive"
      : position.pnlDirection === "up"
        ? "text-primary"
        : "text-foreground";
  const closed = position.closed === true;
  const statusUpperForProbe = (position.status ?? "").toUpperCase();
  const inRecoveryFlowForProbe = statusUpperForProbe === "PARKED" || statusUpperForProbe === "LP_FAILED";
  const canCloseProbe = useCanClosePosition(
    closed || inRecoveryFlowForProbe ? null : position.id,
  );
  const canClaim = position.hasClaimableFees === true;
  // Deposit LP Fallback states surfaced from the Position aggregate (or
  // the local lifecycleStatus fallback). PARKED gets a dedicated
  // "Resume in pool" CTA per dust/03 AC — the user explicitly chose
  // "later", so the row needs an obvious way back into the flow without
  // diving into the detail page first.
  const statusUpper = position.status.toUpperCase();
  const isParked = statusUpper === "PARKED";
  const isLpFailed = statusUpper === "LP_FAILED";
  const inRecoveryFlow = isParked || isLpFailed;

  // Stop propagation so action buttons don't also trigger the row's onOpen.
  const stop = (fn?: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn?.();
  };

  return (
    <button
      type="button"
      onClick={handleOpen}
      className="group relative grid w-full grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))_auto] items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary/30 hover:bg-surface-elevated"
    >
      <span
        aria-hidden
        className={`absolute left-0 top-0 h-full w-[2px] rounded-l-xl ${
          closed
            ? "bg-muted-foreground/40"
            : position.inRange
              ? "bg-primary/70"
              : "bg-amber-500/70"
        }`}
      />

      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{position.poolName}</p>
          <p className="mt-0.5 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            {position.protocol} · {position.openedAt ?? "—"}
          </p>
        </div>
        {!closed && !inRecoveryFlow && (
          <PositionStatusPill inRange={position.inRange} closed={closed} size="sm" />
        )}
        {!closed && !inRecoveryFlow && canCloseProbe.closeable === false && (
          <span
            data-testid="unclosable-position-badge"
            title={`Close not yet available for pools with ${canCloseProbe.extension ?? "this"} mints. v2 capability.`}
            className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-amber-300"
          >
            v2
          </span>
        )}
        {inRecoveryFlow && (
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] ${
              isParked
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-amber-500/40 bg-amber-500/10 text-amber-300"
            }`}
          >
            {isParked ? "Parked" : "LP failed"}
          </span>
        )}
      </div>

      {closed ? (
        <>
          <ListStat label="Deposited" value={position.deposited} />
          <ListStat label="Final value" value={position.value} />
          <ListStat label="Fees" value={position.feesEarned} tone="primary" />
          <ListStat label="P&L" value={position.pnl ?? "—"} className={pnlColor} />
          <ArrowUpRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
        </>
      ) : (
        <>
          <ListStat label="Value" value={position.value} />
          <ListStat label="P&L" value={position.pnl ?? "—"} className={pnlColor} />
          <ListStat label="Fees" value={position.feesEarned} tone="primary" />
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Claimable
            </p>
            <p className="mt-0.5 flex items-center gap-1 truncate font-mono text-sm tabular-nums text-foreground">
              <Coins className="h-3 w-3 text-muted-foreground" />
              {position.claimable ?? "$0.00"}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {inRecoveryFlow ? (
              <Button
                size="sm"
                variant={isParked ? "premium" : "subtle"}
                onClick={stop(handleOpen)}
                className="h-7 rounded-full px-3 text-xs"
              >
                {isParked ? (
                  <PlayCircle className="h-3 w-3" />
                ) : (
                  <Repeat className="h-3 w-3" />
                )}
                {isParked ? "Resume in pool" : "Review recovery"}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="premium"
                  onClick={stop(onClaim)}
                  disabled={!canClaim || !onClaim}
                  className="h-7 rounded-full px-3 text-xs"
                >
                  Claim
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={stop(handleOpen)}
                  className="h-7 rounded-full px-3 text-xs"
                >
                  <Settings2 className="h-3 w-3" />
                  Manage
                </Button>
              </>
            )}
          </div>
        </>
      )}
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
