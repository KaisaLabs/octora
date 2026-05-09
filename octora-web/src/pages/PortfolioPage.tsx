import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { PortfolioPosition } from "@/components/octora/types";
import { Button } from "@/components/ui/button";
import { PositionCard } from "@/components/octora/lp/PositionCard";
import { PnLCalendar } from "@/components/octora/lp/PnLCalendar";
import { PortfolioKpiStrip } from "@/components/octora/lp/PortfolioKpiStrip";
import { PortfolioStatsPanel } from "@/components/octora/lp/PortfolioStatsPanel";
import { generateDailyPnL, summarizePnL } from "@/lib/pnl";
import { useSolana } from "@/providers/SolanaProvider";
import { runClaimFees } from "@/lib/privateLifecycle";

interface PortfolioPageProps {
  positions: PortfolioPosition[];
}

type Tab = "overview" | "active" | "closed";
type Filter = "all" | "in-range" | "out-of-range" | "claimable";

const parseUsd = (v: string | undefined): number => {
  if (!v) return 0;
  const n = parseFloat(v.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

export function PortfolioPage({ positions }: PortfolioPageProps) {
  const [tab, setTab] = useState<Tab>("overview");
  const [filter, setFilter] = useState<Filter>("all");
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

  const totals = useMemo(() => {
    // Closed positions contribute nothing to the totals (value/fees zeroed,
    // no claimable). Skip them up front so the math reflects what the user
    // actually sees on the page.
    const live = positions.filter((p) => !p.closed);
    const value = live.reduce((s, p) => s + parseUsd(p.value), 0);
    const fees = live.reduce((s, p) => s + parseUsd(p.feesEarned), 0);
    const deposited = live.reduce((s, p) => s + parseUsd(p.deposited), 0);
    const claimable = live.reduce((s, p) => s + parseUsd(p.claimable), 0);
    const inRange = live.filter((p) => p.inRange).length;
    const open = live.length;
    const pools = new Set(live.map((p) => p.poolAddress)).size;
    return { value, fees, deposited, claimable, inRange, open, pools };
  }, [positions]);

  const today = useMemo(() => new Date(), []);
  const daily = useMemo(() => {
    const since = new Date(today);
    since.setDate(today.getDate() - 60);
    return generateDailyPnL({ since, until: today, dailyMeanUsd: Math.max(8, totals.deposited * 0.0008) });
  }, [today, totals.deposited]);

  const summary = useMemo(
    () =>
      summarizePnL(daily, {
        totalDeposited: totals.deposited,
        totalPositionValue: totals.value,
        feesClaimed: totals.fees,
        claimableFees: totals.claimable,
      }),
    [daily, totals],
  );

  const livePositions = useMemo(() => positions.filter((p) => !p.closed), [positions]);
  const closedPositions = useMemo(() => positions.filter((p) => p.closed), [positions]);

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
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Your private LP
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {livePositions.length} position{livePositions.length === 1 ? "" : "s"} ·{" "}
            <span
              className={
                totals.open === 0
                  ? "text-muted-foreground"
                  : totals.inRange === totals.open
                    ? "text-primary"
                    : "text-amber-400"
              }
            >
              {totals.inRange}/{totals.open} in range
            </span>
          </p>
        </div>

        {totals.claimable > 0 && (
          <div className="flex items-center gap-3 rounded-full border border-primary/30 bg-primary/5 px-4 py-2">
            <span className="text-xs text-muted-foreground">Claimable</span>
            <span className="font-mono text-sm font-semibold tabular-nums text-primary">
              ${totals.claimable.toLocaleString(undefined, { maximumFractionDigits: 2 })}
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
          <PortfolioKpiStrip summary={summary} />
          <section className="grid gap-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
            <div className="panel-shell rounded-2xl p-5">
              <PortfolioStatsPanel
                summary={summary}
                positionCount={totals.open}
                poolCount={totals.pools}
              />
            </div>
            <div className="panel-shell min-h-[460px] rounded-2xl p-5">
              <PnLCalendar daily={daily} today={today} />
            </div>
          </section>
        </>
      )}

      {tab === "active" && (
        <section className="panel-shell rounded-2xl p-4 sm:p-5">
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

          {filtered.length === 0 ? (
            <div className="mt-6 rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
              {livePositions.length === 0
                ? "No active positions yet. Open a position from the Pools tab to get started."
                : "No positions match this filter."}
            </div>
          ) : (
            <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filtered.map((p) => (
                <PositionCard key={p.id} position={p} onClaim={() => handleClaim(p)} />
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
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {closedPositions.map((p) => (
                <PositionCard key={p.id} position={p} onClaim={() => handleClaim(p)} />
              ))}
            </div>
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
