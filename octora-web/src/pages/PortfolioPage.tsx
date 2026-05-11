import { useMemo, useState } from "react";
import { toast } from "sonner";
import { LayoutGrid, List as ListIcon } from "lucide-react";
import type { PortfolioPosition } from "@/components/octora/types";
import { Button } from "@/components/ui/button";
import { PositionCard } from "@/components/octora/lp/PositionCard";
import { PositionListRow } from "@/components/octora/lp/PositionListRow";
import { PortfolioKpiStrip } from "@/components/octora/lp/PortfolioKpiStrip";
import { PortfolioStatsPanel } from "@/components/octora/lp/PortfolioStatsPanel";
import { ActivityCalendar } from "@/components/octora/lp/ActivityCalendar";
import { computeOverviewMetrics } from "@/lib/pnl";
import { useSolana } from "@/providers/SolanaProvider";
import { runClaimFees } from "@/lib/privateLifecycle";

interface PortfolioPageProps {
  positions: PortfolioPosition[];
}

type Tab = "overview" | "active" | "closed";
type Filter = "all" | "in-range" | "out-of-range" | "claimable";
type ClosedView = "grid" | "list";

export function PortfolioPage({ positions }: PortfolioPageProps) {
  const [tab, setTab] = useState<Tab>("overview");
  const [filter, setFilter] = useState<Filter>("all");
  const [activeView, setActiveView] = useState<ClosedView>("grid");
  const [closedView, setClosedView] = useState<ClosedView>("grid");
  const { wallet } = useSolana();
  const [claimingId, setClaimingId] = useState<string | null>(null);

  const handleClaim = async (position: PortfolioPosition) => {
    if (!wallet.address) {
      toast.error("Connect your wallet first.");
      return;
    }
    if (claimingId) return;
    setClaimingId(position.id);
    const t = toast.loading("Claiming fees…");
    try {
      const res = await runClaimFees({
        mainWalletAddress: wallet.address,
        poolAddress: position.poolAddress,
        lowerBinId: position.rangeLowerBin,
        upperBinId: position.rangeUpperBin,
      });
      toast.success(`Claimed. Funds → ${shortenPk(res.exitRecipient)}`, {
        id: t,
        description: shortenPk(res.signature),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Claim failed.", { id: t });
    } finally {
      setClaimingId(null);
    }
  };

  const metrics = useMemo(() => computeOverviewMetrics(positions), [positions]);

  const livePositions = useMemo(() => positions.filter((p) => !p.closed), [positions]);
  const closedPositions = useMemo(() => positions.filter((p) => p.closed), [positions]);

  const inRangeCount = useMemo(
    () => livePositions.filter((p) => p.inRange).length,
    [livePositions],
  );

  const filtered = useMemo(() => {
    return livePositions.filter((p) => {
      if (filter === "in-range") return p.inRange === true;
      if (filter === "out-of-range") return p.inRange === false;
      if (filter === "claimable") return p.hasClaimableFees === true;
      return true;
    });
  }, [livePositions, filter]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Portfolio</p>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight text-foreground sm:text-4xl [text-shadow:0_2px_18px_hsl(150_33%_2%/0.65)]">
            Your private LP
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {livePositions.length} position{livePositions.length === 1 ? "" : "s"} ·{" "}
            <span
              className={
                metrics.livePositionCount === 0
                  ? "text-muted-foreground"
                  : inRangeCount === metrics.livePositionCount
                    ? "text-primary"
                    : "text-amber-400"
              }
            >
              {inRangeCount}/{metrics.livePositionCount} in range
            </span>
          </p>
        </div>

        {metrics.pendingFeesUsd > 0 && (
          <div className="flex items-center gap-3 rounded-full border border-primary/30 bg-primary/5 px-4 py-2">
            <span className="text-xs text-muted-foreground">Claimable</span>
            <span className="font-mono text-sm font-semibold tabular-nums text-primary">
              ${metrics.pendingFeesUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
            <Button variant="hero" size="sm" className="rounded-full">
              Claim all
            </Button>
          </div>
        )}
      </section>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border/60">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
          Overview
        </TabButton>
        <TabButton active={tab === "active"} onClick={() => setTab("active")}>
          Active Positions
          <span className="ml-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
            {livePositions.length}
          </span>
        </TabButton>
        <TabButton active={tab === "closed"} onClick={() => setTab("closed")}>
          Closed Positions
          <span className="ml-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
            {closedPositions.length}
          </span>
        </TabButton>
      </div>

      {tab === "overview" && (
        <>
          <PortfolioKpiStrip metrics={metrics} />
          <section className="grid gap-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
            <div className="panel-shell rounded-2xl p-5">
              <PortfolioStatsPanel metrics={metrics} />
            </div>
            <div className="panel-shell min-h-[460px] rounded-2xl p-5">
              <ActivityCalendar walletAddress={wallet.address} today={new Date()} />
            </div>
          </section>
        </>
      )}

      {tab === "active" && (
        <section className="panel-shell rounded-2xl p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Filter</span>
              <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
                All ({livePositions.length})
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
            <ViewToggle value={activeView} onChange={setActiveView} />
          </div>

          {filtered.length === 0 ? (
            <div className="mt-6 rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
              {livePositions.length === 0
                ? "No active positions yet. Open a position from the Pools tab to get started."
                : "No positions match this filter."}
            </div>
          ) : activeView === "grid" ? (
            <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filtered.map((p) => (
                <PositionCard key={p.id} position={p} onClaim={() => handleClaim(p)} />
              ))}
            </div>
          ) : (
            <div className="mt-5 flex flex-col gap-2">
              {filtered.map((p) => (
                <PositionListRow key={p.id} position={p} onClaim={() => handleClaim(p)} />
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "closed" && (
        <section className="panel-shell rounded-2xl p-4 sm:p-5">
          {closedPositions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
              No closed positions. Positions you close will appear here.
            </div>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  {closedPositions.length} closed
                </span>
                <ViewToggle value={closedView} onChange={setClosedView} />
              </div>
              {closedView === "grid" ? (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {closedPositions.map((p) => (
                    <PositionCard key={p.id} position={p} onClaim={() => handleClaim(p)} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {closedPositions.map((p) => (
                    <PositionListRow key={p.id} position={p} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}

function TabButton({
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
      className={`relative inline-flex items-center gap-1 px-4 py-2.5 text-sm font-medium transition-colors ${
        active
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
      {active && (
        <span
          aria-hidden
          className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-primary"
        />
      )}
    </button>
  );
}

function shortenPk(pk: string): string {
  if (pk.length <= 12) return pk;
  return `${pk.slice(0, 6)}…${pk.slice(-4)}`;
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

function ViewToggle({
  value,
  onChange,
}: {
  value: ClosedView;
  onChange: (v: ClosedView) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-border bg-secondary/60 p-0.5">
      <ToggleBtn active={value === "grid"} onClick={() => onChange("grid")} label="Grid">
        <LayoutGrid className="h-3.5 w-3.5" />
      </ToggleBtn>
      <ToggleBtn active={value === "list"} onClick={() => onChange("list")} label="List">
        <ListIcon className="h-3.5 w-3.5" />
      </ToggleBtn>
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`rounded px-2 py-1 transition-colors ${
        active
          ? "bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(160_84%_45%_/_0.4)]"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
