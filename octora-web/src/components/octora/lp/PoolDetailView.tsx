import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Copy, Loader2 } from "lucide-react";

import type { DistributionShape, Pool } from "@/components/octora/types";
import { Button } from "@/components/ui/button";
import { BinLiquidityChart } from "@/components/octora/lp/BinLiquidityChart";
import { DistributionPreset } from "@/components/octora/lp/DistributionPreset";
import { PositionStatusPill } from "@/components/octora/lp/PositionStatusPill";
import { PrivateDepositModal } from "@/components/octora/lp/PrivateDepositModal";
import { AnonymityBadge } from "@/components/octora/lp/AnonymityBadge";
import { usePoolBins } from "@/hooks/usePoolBins";
import { getPrices } from "@/lib/api";

interface Props {
  pool: Pool;
  presetShape?: DistributionShape;
  onBack: () => void;
}

const SOL_MINT = "So11111111111111111111111111111111111111112";

export function PoolDetailView({ pool, presetShape, onBack }: Props) {
  // Selected mixer denomination drives both the deposit form (below) and the
  // allocation card (above). MVP is single-sided SOL only, so "allocation" =
  // "how much SOL the user is putting in" — represented as their chosen
  // mixer pool size. Reset to null until the user picks; the deposit panel
  // pre-selects the highest-privacy default once /mixer/pools loads.
  const [selectedDenomLamports, setSelectedDenomLamports] = useState<string | null>(null);
  const [selectedAnonymity, setSelectedAnonymity] = useState<number | null>(null);

  return (
    <div className="space-y-5">
      <div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to pools
        </button>

        <div className="mt-4 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                {pool.protocol}
              </span>
              <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Fee {pool.feeBps} bps
              </span>
              {(pool.tags ?? []).slice(0, 2).map((t) => (
                <span key={t} className="rounded-full border border-border bg-secondary/60 px-2.5 py-1 text-[11px] text-muted-foreground">
                  {t}
                </span>
              ))}
            </div>
            <h2 className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              {pool.name}
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="font-mono text-xs">{pool.address}</span>
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(pool.address)}
                className="inline-flex items-center gap-1 text-foreground transition-colors hover:text-primary"
              >
                <Copy className="h-3.5 w-3.5" /> Copy
              </button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:gap-3 lg:w-[480px]">
            <PoolInfoStat label="TVL" value={pool.tvl} />
            <PoolInfoStat label="24h Vol" value={pool.volume24h} />
            <PoolInfoStat label="APR" value={pool.apr} highlight />
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <InfoCard label="Price range" value={pool.priceRange} helper={pool.binRange} />
          <InfoCard label="Depth" value={pool.depth} helper={pool.risk} />
          <InfoCard
            label="Allocation"
            value={
              selectedDenomLamports
                ? `${formatSol(selectedDenomLamports)} · Single-sided SOL`
                : "Single-sided SOL"
            }
            helper={
              selectedAnonymity !== null
                ? `Anonymity set: ${selectedAnonymity} unspent`
                : "Pick a size below — MEME fills as price moves"
            }
          />
          <InfoCard label="24h Fees" value={pool.fees24h} helper="Across active bins" />
        </div>
      </div>

      <DepositPanel
        pool={pool}
        presetShape={presetShape}
        selectedDenomLamports={selectedDenomLamports}
        onChangeDenom={(d, anonymity) => {
          setSelectedDenomLamports(d);
          setSelectedAnonymity(anonymity);
        }}
      />
    </div>
  );
}

function DepositPanel({
  pool,
  presetShape,
  selectedDenomLamports,
  onChangeDenom,
}: {
  pool: Pool;
  presetShape?: DistributionShape;
  selectedDenomLamports: string | null;
  onChangeDenom: (lamports: string, anonymitySet: number) => void;
}) {
  const { bins, activeBinId, isLoading: binsLoading, isFallback } = usePoolBins(pool, 61);

  const [shape, setShape] = useState<DistributionShape>(presetShape ?? "curve");
  const [depositOpen, setDepositOpen] = useState(false);

  // SOL/USD price drives the summary calculations (entry fee, daily est, etc.)
  // since the user now picks SOL amount instead of USD freetext. Falls back
  // to a sensible devnet value when /api/prices doesn't know SOL.
  // `quoteUsdPrice` is the USD price of the pool's quote token (tokenY) —
  // used to convert the DLMM bin price (tokenY-per-tokenX) into USD-per-X
  // so the detail page reads in the same denomination as discovery's
  // LIVE PRICE column.
  const [solUsdPrice, setSolUsdPrice] = useState<number>(200);
  const [quoteUsdPrice, setQuoteUsdPrice] = useState<number>(0);
  useEffect(() => {
    let cancelled = false;
    const mints = Array.from(new Set([SOL_MINT, pool.tokenBMint])).filter(Boolean);
    getPrices(mints)
      .then((prices) => {
        if (cancelled) return;
        const sol = prices[SOL_MINT]?.usdPrice;
        if (sol && sol > 0) setSolUsdPrice(sol);
        const quote = prices[pool.tokenBMint]?.usdPrice;
        if (quote && quote > 0) setQuoteUsdPrice(quote);
      })
      .catch(() => {
        // Keep the $200 fallback — summary numbers are guidance, not
        // settlement, so a missing oracle quote shouldn't block the flow.
      });
    return () => {
      cancelled = true;
    };
  }, [pool.tokenBMint]);

  // Derived USD value drives the existing summary / projection block + the
  // PrivateDepositModal's preview UI without us having to refactor that
  // surface too.
  const depositUsd = selectedDenomLamports
    ? (Number(BigInt(selectedDenomLamports)) / 1_000_000_000) * solUsdPrice
    : 0;

  useEffect(() => {
    if (presetShape) setShape(presetShape);
  }, [presetShape]);

  // Range guards: only enforce `lower <= upper`. Earlier versions hard-clamped
  // the range to one side of `activeBinId` to keep single-sided SOL deposits
  // strictly on the SOL side, but that prevented the user from picking a
  // range that straddles the current price — a common LP strategy (cover
  // both directions of price movement). The on-chain deposit still sends
  // `amountX=0` or `amountY=0` (whichever isn't SOL), so wrong-side bins
  // simply receive no liquidity at deposit; they capture SOL only if price
  // later moves into them. See planSingleSidedSol on the backend.
  const clampRange = (r: { lower: number; upper: number }) => {
    if (r.upper < r.lower) return { lower: r.upper, upper: r.lower };
    return r;
  };

  const [range, setRange] = useState<{ lower: number; upper: number }>(() =>
    clampRange({ lower: activeBinId - 8, upper: activeBinId + 8 }),
  );

  useEffect(() => {
    setRange(clampRange({ lower: activeBinId - 8, upper: activeBinId + 8 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBinId]);

  const setRangeClamped: typeof setRange = (next) => {
    setRange((prev) => {
      const candidate = typeof next === "function" ? (next as (p: typeof prev) => typeof prev)(prev) : next;
      return clampRange(candidate);
    });
  };

  const lowerPrice = bins.find((b) => b.binId === range.lower)?.price ?? 0;
  const upperPrice = bins.find((b) => b.binId === range.upper)?.price ?? 0;
  const activePrice = bins.find((b) => b.binId === activeBinId)?.price ?? 0;

  const lowerPct = activePrice ? ((lowerPrice - activePrice) / activePrice) * 100 : 0;
  const upperPct = activePrice ? ((upperPrice - activePrice) / activePrice) * 100 : 0;
  const binsCovered = Math.max(0, range.upper - range.lower + 1);

  const projection = useMemo(() => {
    const entryFee = depositUsd * (pool.feeBps / 10000);
    const concentration = Math.max(1, 60 / Math.max(binsCovered, 1));
    const baseDaily = (depositUsd * (parseFloat(pool.apr) / 100)) / 365;
    const estimatedDaily = baseDaily * Math.min(concentration, 6);
    const monthlyRange = estimatedDaily * 30;
    return { entryFee, estimatedDaily, monthlyRange, concentration };
  }, [depositUsd, pool, binsCovered]);

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Strategy</p>
          <h3 className="mt-1 font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Shape your liquidity
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Drag the handles to set your range. Pick a shape to spread liquidity.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start text-xs text-muted-foreground">
          <span className="rounded-full border border-border bg-secondary/60 px-2.5 py-1 font-mono">
            Bin step {pool.binStep || "—"}
          </span>
          <span className="rounded-full border border-border bg-secondary/60 px-2.5 py-1 font-mono">
            {binsCovered} bins
          </span>
        </div>
      </div>

      <div className="rounded-2xl border border-border/70 bg-card/60 p-3 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Active price</span>
            <span className="font-mono text-base text-foreground tabular-nums">{formatPrice(activePrice)}</span>
            <span className="text-xs text-muted-foreground">
              {pool.tokenA}/{pool.tokenB}
            </span>
            {quoteUsdPrice > 0 && activePrice > 0 && (
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                ≈ {formatUsd(activePrice * quoteUsdPrice)} / {pool.tokenA}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <BinSourceBadge loading={binsLoading} fallback={isFallback} />
            <PositionStatusPill inRange size="sm" label="Active in range" />
          </div>
        </div>

        <BinLiquidityChart
          bins={bins}
          activeBinId={activeBinId}
          range={range}
          shape={shape}
          depositUsd={depositUsd}
          onRangeChange={setRangeClamped}
          height={240}
        />

        <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-3">
          <RangeReadout
            label="Min price"
            price={lowerPrice}
            pct={lowerPct}
            onAdjust={(d) => setRangeClamped((r) => ({ lower: r.lower + d, upper: r.upper }))}
          />
          <RangeReadout label="Active" price={activePrice} pct={0} center />
          <RangeReadout
            label="Max price"
            price={upperPrice}
            pct={upperPct}
            onAdjust={(d) => setRangeClamped((r) => ({ lower: r.lower, upper: r.upper + d }))}
          />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">Distribution</p>
            <DistributionPreset value={shape} onChange={setShape} />
          </div>

          <div className="space-y-2">
            <span className="text-sm text-muted-foreground">Deposit size (mixer pool)</span>
            <SolDenominationPicker
              value={selectedDenomLamports}
              onChange={onChangeDenom}
            />
            <p className="text-[11px] leading-5 text-muted-foreground">
              Single-sided SOL: you deposit SOL, MEME accumulates in your
              bins as price moves. Your range can sit above, below, or
              straddle the current active price — bins on the wrong side
              of active receive no SOL at deposit and capture it
              organically as price moves into them. The mixer pool size
              above is what gets routed through the privacy chain, so
              your withdrawal looks identical to every other user's
              withdrawal from the same pool.
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Summary</p>
          <div className="mt-4 space-y-3.5">
            <OutcomeRow label="Bins entered" value={`${binsCovered}`} />
            <OutcomeRow label="Capital efficiency" value={`${projection.concentration.toFixed(1)}x`} accent />
            <OutcomeRow label="Entry fee" value={`$${projection.entryFee.toFixed(2)}`} />
            <OutcomeRow label="Est. daily fees" value={`$${projection.estimatedDaily.toFixed(2)}`} />
            <OutcomeRow label="30d est." value={`$${projection.monthlyRange.toFixed(2)}`} />
            <OutcomeRow label="Execution" value="Private relay" />
          </div>
          {isFallback && !binsLoading && (
            <div className="mt-5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-5 text-amber-200">
              Live bin data unavailable for this pool. The chart shows a
              modeled distribution centered at price 1.0 — the on-chain
              active bin is elsewhere, so any deposit submitted now would
              be rejected by the relayer. Try again in a moment, or pick a
              different pool.
            </div>
          )}
          <Button
            variant="hero"
            size="lg"
            className="mt-5 w-full justify-center rounded-xl"
            onClick={() => setDepositOpen(true)}
            disabled={
              !selectedDenomLamports ||
              range.upper < range.lower ||
              isFallback ||
              binsLoading
            }
          >
            {binsLoading
              ? "Loading bins…"
              : isFallback
                ? "Live bins unavailable"
                : "Deposit privately"}
            {!binsLoading && !isFallback && <ArrowRight />}
          </Button>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            Routed via Octora's private relayer. Origin wallet stays hidden.
          </p>
        </div>
      </div>

      <PrivateDepositModal
        open={depositOpen}
        onOpenChange={setDepositOpen}
        pool={pool}
        depositUsd={depositUsd}
        shape={shape}
        range={range}
        preselectedDenominationLamports={selectedDenomLamports}
      />
    </section>
  );
}


function formatPrice(p: number): string {
  if (!Number.isFinite(p) || p === 0) return "—";
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  // Sub-0.01 prices (typical for meme/SOL pairs) — show enough decimal
  // places to surface ~4 significant figures. Strip trailing zeros so a
  // round number like 0.001500 reads as "0.0015" instead of "0.001500".
  const magnitude = Math.floor(Math.log10(p));
  const decimals = Math.max(4, 3 - magnitude);
  return p.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

function formatUsd(p: number): string {
  if (!Number.isFinite(p) || p === 0) return "$0";
  if (p >= 1000) return `$${p.toFixed(2)}`;
  if (p >= 1) return `$${p.toFixed(4)}`;
  if (p >= 0.01) return `$${p.toFixed(5)}`;
  const magnitude = Math.floor(Math.log10(p));
  const decimals = Math.max(4, 3 - magnitude);
  return `$${p.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function RangeReadout({
  label,
  price,
  pct,
  center,
  onAdjust,
}: {
  label: string;
  price: number;
  pct: number;
  center?: boolean;
  onAdjust?: (delta: number) => void;
}) {
  return (
    <div
      className={`rounded-xl border ${
        center ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-secondary/40"
      } px-3 py-2.5`}
    >
      <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        <span>{label}</span>
        {onAdjust && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onAdjust(-1)}
              className="rounded border border-border bg-card px-1.5 leading-none text-foreground/70 transition-colors hover:text-foreground"
            >
              −
            </button>
            <button
              type="button"
              onClick={() => onAdjust(1)}
              className="rounded border border-border bg-card px-1.5 leading-none text-foreground/70 transition-colors hover:text-foreground"
            >
              +
            </button>
          </div>
        )}
      </div>
      <p className="mt-1.5 font-mono text-sm text-foreground tabular-nums">{formatPrice(price)}</p>
      <p
        className={`mt-0.5 text-[11px] tabular-nums ${
          center ? "text-amber-400" : pct >= 0 ? "text-primary" : "text-muted-foreground"
        }`}
      >
        {center ? "On-chain active" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
      </p>
    </div>
  );
}

function PoolInfoStat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
      <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground sm:text-xs">{label}</p>
      <p className={`mt-1.5 text-base font-semibold sm:text-lg ${highlight ? "text-primary" : "text-foreground"}`}>
        {value}
      </p>
    </div>
  );
}

function InfoCard({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-sm font-medium text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{helper}</p>
    </div>
  );
}

function BinSourceBadge({ loading, fallback }: { loading: boolean; fallback: boolean }) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
        Loading bins
      </span>
    );
  }
  if (fallback) {
    return (
      <span
        title="Live bin data unavailable; showing modeled distribution."
        className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-amber-300"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        Modeled
      </span>
    );
  }
  return (
    <span
      title="Live bin liquidity from on-chain DLMM."
      className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-primary"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_6px_hsl(160_84%_55%)]" />
      On-chain
    </span>
  );
}

function OutcomeRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/80 pb-3 last:border-b-0 last:pb-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`font-mono text-sm font-medium tabular-nums ${accent ? "text-primary" : "text-foreground"}`}>
        {value}
      </span>
    </div>
  );
}

/**
 * Mixer-denomination picker for the deposit form. Pulls the live pool list
 * from /mixer/pools so the displayed sizes + anonymity sets match what the
 * server will actually accept. Mirrors the modal-side `DenominationSelector`
 * but is laid out inline (no preview body, no pop-over copy).
 */
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";

interface MixerPoolEntry {
  denomination: string;
  initialized?: boolean;
  anonymitySet?: number;
  isPaused?: boolean;
}

function SolDenominationPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (lamports: string, anonymitySet: number) => void;
}) {
  const [pools, setPools] = useState<MixerPoolEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/mixer/pools`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ pools: MixerPoolEntry[]; anonymitySetMin?: number }>;
      })
      .then((data) => {
        if (cancelled) return;
        setPools(data.pools ?? []);
        // Auto-select largest "strong" pool when nothing chosen yet, so the
        // header allocation card and the projection numbers populate
        // without the user having to click first.
        if (!value && data.pools && data.pools.length > 0) {
          const min = data.anonymitySetMin ?? 20;
          const strong = [...data.pools]
            .filter((p) => (p.anonymitySet ?? 0) >= min)
            .sort((a, b) => Number(b.denomination) - Number(a.denomination))[0];
          const fallback = data.pools[0]!;
          const chosen = strong ?? fallback;
          onChange(chosen.denomination, chosen.anonymitySet ?? 0);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
        Couldn't load mixer pools: {error}
      </div>
    );
  }
  if (!pools) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/60 bg-card/40 px-3 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading mixer pools…
      </div>
    );
  }
  if (pools.length === 0) {
    return (
      <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 text-xs text-muted-foreground">
        No mixer pools configured on this network.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-3 gap-2">
      {pools.map((pool) => {
        const selected = pool.denomination === value;
        const usable = pool.initialized !== false && pool.isPaused !== true;
        return (
          <button
            key={pool.denomination}
            type="button"
            disabled={!usable}
            onClick={() => onChange(pool.denomination, pool.anonymitySet ?? 0)}
            className={[
              "flex flex-col items-stretch gap-1.5 rounded-xl border px-3 py-3 text-left transition-colors",
              "disabled:cursor-not-allowed disabled:opacity-50",
              selected
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-card/60 text-muted-foreground hover:border-border hover:text-foreground",
            ].join(" ")}
          >
            <span className="font-mono text-base font-semibold tabular-nums">
              {formatSol(pool.denomination)}
            </span>
            {pool.anonymitySet !== undefined ? (
              <AnonymityBadge anonymitySet={pool.anonymitySet} compact />
            ) : (
              <span className="text-[10px] uppercase tracking-wide opacity-70">
                Not initialized
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function formatSol(lamportsStr: string): string {
  try {
    const lamports = BigInt(lamportsStr);
    const whole = lamports / 1_000_000_000n;
    const frac = lamports % 1_000_000_000n;
    if (frac === 0n) return `${whole} SOL`;
    const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
    return `${whole}.${fracStr} SOL`;
  } catch {
    return `${lamportsStr} lamports`;
  }
}
