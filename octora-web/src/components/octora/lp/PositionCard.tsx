import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, Coins, Settings2 } from "lucide-react";
import type { LiquidityBin, PortfolioPosition } from "@/components/octora/types";
import { Button } from "@/components/ui/button";
import { BinLiquidityChart } from "./BinLiquidityChart";
import { PositionStatusPill } from "./PositionStatusPill";
import { projectUserShape } from "@/lib/bins";

interface Props {
  position: PortfolioPosition;
  onManage?: () => void;
  onClaim?: () => void;
}

/** Build a synthetic bin window centered on the position's active bin. */
function buildPositionBins(p: PortfolioPosition): LiquidityBin[] {
  const center = p.activeBinId ?? 0;
  const lower = p.rangeLowerBin ?? center - 8;
  const upper = p.rangeUpperBin ?? center + 8;
  const halfSpan = Math.max(20, Math.max(Math.abs(lower - center), Math.abs(upper - center)) + 8);
  const count = halfSpan * 2 + 1;
  return Array.from({ length: count }, (_, i) => {
    const binId = center - halfSpan + i;
    const d = binId - center;
    const liquidity = Math.exp(-(d * d) / (2 * (halfSpan / 3) * (halfSpan / 3)));
    return { binId, price: 1 + binId * 0.001, liquidity };
  });
}

export function PositionCard({ position, onManage, onClaim }: Props) {
  const navigate = useNavigate();
  const handleManage = onManage ?? (() => navigate(`/position/${position.id}`));
  const bins = useMemo(() => buildPositionBins(position), [position]);
  const center = position.activeBinId ?? 0;
  const lower = position.rangeLowerBin ?? center - 8;
  const upper = position.rangeUpperBin ?? center + 8;
  const userOverlay = useMemo(
    () => projectUserShape(bins, lower, upper, position.shape ?? "spot", 100),
    [bins, lower, upper, position.shape],
  );
  const canClaim = position.hasClaimableFees === true;

  return (
    <article className="group relative overflow-hidden rounded-2xl border border-border bg-card transition-colors hover:border-primary/30">
      {/* Status accent rail */}
      <span
        aria-hidden
        className={`absolute left-0 top-0 h-full w-[2px] ${
          position.closed
            ? "bg-muted-foreground/40"
            : position.inRange
              ? "bg-primary/70"
              : "bg-amber-500/70"
        }`}
      />

      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <header className="flex items-start justify-between gap-3">
          <div>
            <p className="font-display text-lg font-semibold tracking-tight text-foreground">
              {position.poolName}
            </p>
            <p className="mt-0.5 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
              {position.protocol} · {position.openedAt ?? "—"}
            </p>
          </div>
          <PositionStatusPill inRange={position.inRange} closed={position.closed} size="sm" />
        </header>

        {/* Mini bin chart */}
        <div className="rounded-lg border border-border/60 bg-background/40 p-2">
          <BinLiquidityChart
            bins={bins}
            activeBinId={center}
            range={{ lower, upper }}
            shape={position.shape ?? "spot"}
            userLiquidity={userOverlay}
            height={80}
            compact
          />
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-3 text-sm">
          <Stat label="Value" value={position.value} />
          <Stat
            label="P&L"
            value={position.pnl ?? "—"}
            tone={position.pnlDirection === "down" ? "down" : position.pnlDirection === "up" ? "up" : undefined}
          />
          <Stat label="Fees" value={position.feesEarned} tone="up" />
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Coins className="h-3.5 w-3.5" />
            <span className="tabular-nums text-foreground">{position.claimable ?? "$0.00"}</span>
            <span>claimable</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="premium"
              onClick={onClaim}
              disabled={!canClaim}
              className="rounded-full"
            >
              Claim
            </Button>
            <Button size="sm" variant="subtle" onClick={handleManage} className="rounded-full">
              <Settings2 className="h-3.5 w-3.5" />
              Manage
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const color = tone === "up" ? "text-primary" : tone === "down" ? "text-destructive" : "text-foreground";
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className={`mt-1 font-mono text-sm font-medium tabular-nums ${color}`}>{value}</p>
    </div>
  );
}
