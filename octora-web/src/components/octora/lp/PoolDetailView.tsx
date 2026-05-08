import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Coins, Copy, Flame, Loader2, Minus } from "lucide-react";
import { toast } from "sonner";

import type { DistributionShape, Pool } from "@/components/octora/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BinLiquidityChart } from "@/components/octora/lp/BinLiquidityChart";
import { DistributionPreset } from "@/components/octora/lp/DistributionPreset";
import { PositionStatusPill } from "@/components/octora/lp/PositionStatusPill";
import { PrivateDepositModal } from "@/components/octora/lp/PrivateDepositModal";
import { usePoolBins } from "@/hooks/usePoolBins";
import { useSolana } from "@/providers/SolanaProvider";
import { runClaimFees, runWithdrawClose } from "@/lib/privateLifecycle";

interface Props {
  pool: Pool;
  presetShape?: DistributionShape;
  onBack: () => void;
}

/**
 * Tri-state position presence shared by Claim and Withdraw panels.
 *
 * - "unknown" = haven't checked yet (no wallet click).
 * - "missing" = either /executor/pool-authority returned 404 on a previous
 *   click, OR the user just closed the position via withdraw-close.
 *   Both panels grey out their action button and show empty-state copy.
 * - "exists"  = at least one successful CPI happened this session against a
 *   live PoolAuthority. Buttons stay enabled.
 */
type PositionStatus = "unknown" | "missing" | "exists";

export function PoolDetailView({ pool, presetShape, onBack }: Props) {
  const [detailTab, setDetailTab] = useState("deposit");
  const [positionStatus, setPositionStatus] = useState<PositionStatus>("unknown");

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
            value={`${pool.allocation.tokenA}% ${pool.tokenA} / ${pool.allocation.tokenB}% ${pool.tokenB}`}
            helper="Suggested split"
          />
          <InfoCard label="24h Fees" value={pool.fees24h} helper="Across active bins" />
        </div>
      </div>

      <Tabs value={detailTab} onValueChange={setDetailTab}>
        <TabsList className="h-auto w-full justify-start overflow-x-auto rounded-lg border border-border bg-secondary/60 p-1 sm:w-auto">
          <TabsTrigger value="deposit" className="rounded-md px-4 py-2 text-sm data-[state=active]:bg-surface-elevated">Add liquidity</TabsTrigger>
          <TabsTrigger value="claim" className="rounded-md px-4 py-2 text-sm data-[state=active]:bg-surface-elevated">Claim</TabsTrigger>
          <TabsTrigger value="withdraw" className="rounded-md px-4 py-2 text-sm data-[state=active]:bg-surface-elevated">Withdraw</TabsTrigger>
        </TabsList>

        <TabsContent value="deposit" className="mt-4">
          <DepositPanel pool={pool} presetShape={presetShape} />
        </TabsContent>
        <TabsContent value="claim" className="mt-4">
          <ClaimPanel pool={pool} positionStatus={positionStatus} setPositionStatus={setPositionStatus} />
        </TabsContent>
        <TabsContent value="withdraw" className="mt-4">
          <WithdrawPanel pool={pool} positionStatus={positionStatus} setPositionStatus={setPositionStatus} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DepositPanel({ pool, presetShape }: { pool: Pool; presetShape?: DistributionShape }) {
  const { bins, activeBinId, isLoading: binsLoading, isFallback } = usePoolBins(pool, 61);

  const [depositUsd, setDepositUsd] = useState(2500);
  const [shape, setShape] = useState<DistributionShape>(presetShape ?? "curve");
  const [depositOpen, setDepositOpen] = useState(false);

  useEffect(() => {
    if (presetShape) setShape(presetShape);
  }, [presetShape]);

  // Single-sided SOL clamp: privacy flow can only deposit one token, so a
  // straddling range would silently widen into the non-SOL side and reject
  // server-side. Detect the SOL side from the pool mints and constrain the
  // initial range + every setRange call to bins on that side of active.
  // Non-SOL pools fall back to the prior straddling default.
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const solSide: "x" | "y" | null =
    pool.tokenAMint === SOL_MINT ? "x" : pool.tokenBMint === SOL_MINT ? "y" : null;
  const clampRange = (r: { lower: number; upper: number }) => {
    if (solSide === "y") {
      const upper = Math.min(r.upper, activeBinId - 1);
      return { lower: Math.min(r.lower, upper), upper };
    }
    if (solSide === "x") {
      const lower = Math.max(r.lower, activeBinId + 1);
      return { lower, upper: Math.max(r.upper, lower) };
    }
    return r;
  };

  const [range, setRange] = useState<{ lower: number; upper: number }>(() =>
    clampRange({ lower: activeBinId - 8, upper: activeBinId + 8 }),
  );

  useEffect(() => {
    setRange(clampRange({ lower: activeBinId - 8, upper: activeBinId + 8 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBinId, solSide]);

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

          <label className="block space-y-2">
            <span className="text-sm text-muted-foreground">Deposit (USD)</span>
            <Input
              type="number"
              min={100}
              step={100}
              value={depositUsd}
              onChange={(e) => setDepositUsd(Number(e.target.value))}
              className="h-12 rounded-xl border-border bg-background font-mono text-base tabular-nums"
            />
            <div className="flex flex-wrap gap-2 pt-1">
              {[500, 1000, 5000, 10000].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setDepositUsd(v)}
                  className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  ${v.toLocaleString()}
                </button>
              ))}
            </div>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <StrategyTile
              title={`${pool.tokenA} allocation`}
              value={`$${((depositUsd * pool.allocation.tokenA) / 100).toFixed(0)}`}
              helper={`${pool.allocation.tokenA}%`}
            />
            <StrategyTile
              title={`${pool.tokenB} allocation`}
              value={`$${((depositUsd * pool.allocation.tokenB) / 100).toFixed(0)}`}
              helper={`${pool.allocation.tokenB}%`}
            />
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
          <Button
            variant="hero"
            size="lg"
            className="mt-5 w-full justify-center rounded-xl"
            onClick={() => setDepositOpen(true)}
            disabled={depositUsd <= 0 || range.upper < range.lower}
          >
            Deposit privately
            <ArrowRight />
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
      />
    </section>
  );
}

function ClaimPanel({
  pool,
  positionStatus,
  setPositionStatus,
}: {
  pool: Pool;
  positionStatus: PositionStatus;
  setPositionStatus: (s: PositionStatus) => void;
}) {
  const { wallet } = useSolana();
  const fees = (parseFloat(pool.apr) / 365) * 30 * 100;
  const [pending, setPending] = useState(false);
  const [lastSig, setLastSig] = useState<string | null>(null);

  const handleClaim = async () => {
    if (!wallet.address) {
      toast.error("Connect your wallet first.");
      return;
    }
    setPending(true);
    const t = toast.loading("Deriving stealth + locating your position…");
    try {
      const res = await runClaimFees({
        mainWalletAddress: wallet.address,
        poolAddress: pool.address,
      });
      setPositionStatus("exists");
      setLastSig(res.signature);
      toast.success(`Claimed. Funds → ${shorten(res.exitRecipient)}`, {
        id: t,
        description: shorten(res.signature),
      });
    } catch (err) {
      if (isPositionMissingError(err)) {
        setPositionStatus("missing");
        toast.error(
          "No private position in this pool yet. Open one from the Add Liquidity tab.",
          { id: t },
        );
      } else {
        toast.error(describeErr(err), { id: t });
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Earnings</p>
          <h3 className="mt-1 text-xl font-semibold text-foreground sm:text-2xl">Claim fees & rewards</h3>
        </div>
        <Coins className="h-5 w-5 text-primary" />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <ClaimTile label="Unclaimed fees" value={`$${fees.toFixed(2)}`} sub={pool.tokenA + " + " + pool.tokenB} />
        <ClaimTile label="MET rewards" value="124.8 MET" sub="≈ $38.20" />
        <ClaimTile label="Last claim" value="3 days ago" sub="Privately settled" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Button
          variant="hero"
          size="lg"
          className="w-full justify-center rounded-xl"
          onClick={handleClaim}
          disabled={pending || !wallet.connected || positionStatus === "missing"}
        >
          {pending ? <Loader2 className="animate-spin" /> : <Coins />}
          {pending ? "Claiming…" : positionStatus === "missing" ? "No position to claim" : "Claim fees"}
        </Button>
        <Button
          variant="premium"
          size="lg"
          className="w-full justify-center rounded-xl"
          disabled
          // MAINNET_BLOCKER: MET rewards CPI not implemented. Disable and
          // explain rather than wire to a fake handler. Pre-mainnet sweep:
          // implement claim_rewards on the executor program + bridge here.
          title="MET rewards claim is coming soon — for now this only claims swap fees."
        >
          <Flame />
          Claim rewards
        </Button>
      </div>

      {lastSig && (
        <p className="text-xs leading-5 text-muted-foreground">
          Last tx: <span className="font-mono text-foreground">{shorten(lastSig)}</span>
        </p>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        {!wallet.connected
          ? "Connect your wallet to claim fees from your private position in this pool."
          : positionStatus === "missing"
            ? "No private position detected here. Open one from the Add Liquidity tab and try again."
            : "Claim runs the on-chain dlmm_claim_fees CPI from your stealth wallet. Fees settle to your private exit address."}
      </p>
    </section>
  );
}

function WithdrawPanel({
  pool,
  positionStatus,
  setPositionStatus,
}: {
  pool: Pool;
  positionStatus: PositionStatus;
  setPositionStatus: (s: PositionStatus) => void;
}) {
  const { wallet } = useSolana();
  const [pct, setPct] = useState(100);
  const [pending, setPending] = useState(false);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const positionValue = 12480;
  const withdrawValue = (positionValue * pct) / 100;

  const handleWithdraw = async () => {
    if (!wallet.address) {
      toast.error("Connect your wallet first.");
      return;
    }
    if (pct !== 100) {
      // MAINNET_BLOCKER: partial withdraws not implemented. The slider is
      // cosmetic — runWithdrawClose always closes 100%. Pre-mainnet sweep:
      // pass bps_to_remove from UI through to /executor/withdraw-close-tx.
      toast.message("MVP exits 100% of the position. Partial withdraws are coming.");
    }
    setPending(true);
    const t = toast.loading("Deriving stealth + locating your position…");
    try {
      const res = await runWithdrawClose({
        mainWalletAddress: wallet.address,
        poolAddress: pool.address,
      });
      // The position account is closed on a 100% bps exit, so the next
      // claim/withdraw against this (wallet, pool) MUST find nothing on
      // chain. Mark missing immediately so the UI doesn't have to wait
      // for the next click to discover that.
      setPositionStatus("missing");
      setLastSig(res.signature);
      toast.success(`Closed. Funds → ${shorten(res.exitRecipient)}`, {
        id: t,
        description: shorten(res.signature),
      });
    } catch (err) {
      if (isPositionMissingError(err)) {
        setPositionStatus("missing");
        toast.error(
          "No private position in this pool yet. Open one from the Add Liquidity tab.",
          { id: t },
        );
      } else {
        toast.error(describeErr(err), { id: t });
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Remove liquidity</p>
          <h3 className="mt-1 text-xl font-semibold text-foreground sm:text-2xl">Withdraw from {pool.name}</h3>
        </div>
        <Minus className="h-5 w-5 text-primary" />
      </div>

      <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Withdraw amount</p>
          <p className="text-sm font-medium text-foreground">{pct}%</p>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={pct}
          onChange={(e) => setPct(Number(e.target.value))}
          className="mt-3 w-full accent-[hsl(var(--primary))]"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {[25, 50, 75, 100].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setPct(v)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                pct === v
                  ? "border-primary/40 bg-surface-elevated text-foreground"
                  : "border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {v}%
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <ClaimTile label="Receive" value={`$${withdrawValue.toFixed(0)}`} sub="Estimated value" />
        <ClaimTile
          label={pool.tokenA}
          value={`${((withdrawValue * pool.allocation.tokenA) / 100).toFixed(2)}`}
          sub="Tokens"
        />
        <ClaimTile
          label={pool.tokenB}
          value={`${((withdrawValue * pool.allocation.tokenB) / 100).toFixed(2)}`}
          sub="Tokens"
        />
      </div>

      <Button
        variant="hero"
        size="lg"
        className="w-full justify-center rounded-xl"
        onClick={handleWithdraw}
        disabled={pending || !wallet.connected || positionStatus === "missing"}
      >
        {pending ? <Loader2 className="animate-spin" /> : null}
        {pending
          ? "Withdrawing…"
          : positionStatus === "missing"
            ? "No position to withdraw"
            : "Withdraw privately"}
        {!pending && positionStatus !== "missing" && <ArrowRight />}
      </Button>
      {lastSig && (
        <p className="text-xs leading-5 text-muted-foreground">
          Last tx: <span className="font-mono text-foreground">{shorten(lastSig)}</span>
        </p>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        {!wallet.connected
          ? "Connect your wallet to withdraw your private position in this pool."
          : positionStatus === "missing"
            ? "No private position detected (or it has been closed). Open a new one from the Add Liquidity tab."
            : "Withdraw runs the on-chain dlmm_withdraw_close CPI from your stealth wallet. Funds return to your private exit address — your main wallet stays unlinked."}
      </p>
    </section>
  );
}

function shorten(addr: string): string {
  if (!addr || addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Recognise the "PoolAuthority not initialised" 404 from /executor/pool-authority
 * surfaced through privateLifecycle.ts as `Error("API 404: ...")`. Anything
 * else (network errors, tx failures, RPC outages) keeps the generic toast.
 */
function isPositionMissingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /\b404\b/.test(err.message) || /not initialised|not initialized|PoolAuthority/i.test(err.message);
}

function formatPrice(p: number): string {
  if (!Number.isFinite(p) || p === 0) return "—";
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  return p.toExponential(3);
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
        {center ? "Mid price" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
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

function StrategyTile({ title, value, helper }: { title: string; value: string; helper: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="mt-1.5 text-xl font-semibold text-foreground sm:text-2xl">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{helper}</p>
    </div>
  );
}

function ClaimTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-lg font-semibold text-foreground sm:text-xl">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
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
