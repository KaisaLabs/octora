import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, ArrowRight, Coins, Copy, ExternalLink, Loader2, Minus, Repeat } from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Connection, PublicKey } from "@solana/web3.js";

import type { DistributionShape, LiquidityBin, PortfolioPosition } from "@/components/octora/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BinLiquidityChart } from "@/components/octora/lp/BinLiquidityChart";
import { DistributionPreset } from "@/components/octora/lp/DistributionPreset";
import { PositionStatusPill } from "@/components/octora/lp/PositionStatusPill";
import { PnLBreakdownPanel } from "@/components/octora/lp/PnLBreakdownPanel";
import { Reveal } from "@/components/octora/lp/Reveal";
import { binPrice, projectUserShape } from "@/lib/bins";
import {
  runPrivateExitToMain,
  runSweepStealthToMain,
} from "@/lib/privateLifecycle";
import {
  listLocalPositions,
  markLocalPositionClosed,
  markLocalPositionLifecycleStatus,
  markLocalPositionWithdrawn,
  recordCloseWitness,
  removeLocalPosition,
} from "@/lib/localPositions";
import {
  MissingWithdrawWitnessError,
  runUserSignedRecovery,
} from "@/lib/userSignedRecovery";
import {
  MissingCloseWitnessError,
  runUserSignedCloseRecovery,
  type CloseRecoveryAction,
} from "@/lib/userSignedCloseRecovery";
import { UserSignedRecoveryDisclosure } from "@/components/octora/lp/UserSignedRecoveryDisclosure";
import { UserSignedCloseRecoveryDisclosure } from "@/components/octora/lp/UserSignedCloseRecoveryDisclosure";
import { useSolana } from "@/providers/SolanaProvider";
import { getPrices } from "@/lib/api";
import { PrivateClaimModal } from "@/components/octora/lp/PrivateClaimModal";
import { PrivateExitModal } from "@/components/octora/lp/PrivateExitModal";
import { PrivateRebalanceModal } from "@/components/octora/lp/PrivateRebalanceModal";
import { StealthAddressDisplay } from "@/components/octora/lp/StealthAddressDisplay";
import { EarnedFeesCard } from "@/components/octora/lp/EarnedFeesCard";
// close/02 — confirmation modal (slippage selector + quote preview).
import {
  CloseConfirmDialog,
  type CloseQuoteResponse,
} from "@/components/octora/lp/CloseConfirmDialog";
import { useCanClosePosition } from "@/hooks/useCanClosePosition";

interface Props {
  positions: PortfolioPosition[];
}

const parseUsd = (v: string | undefined): number => {
  if (!v) return 0;
  const n = parseFloat(v.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

function buildPositionBins(p: PortfolioPosition): LiquidityBin[] {
  const center = p.activeBinId ?? 0;
  const lower = p.rangeLowerBin ?? center - 8;
  const upper = p.rangeUpperBin ?? center + 8;
  const halfSpan = Math.max(28, Math.max(Math.abs(lower - center), Math.abs(upper - center)) + 12);
  const count = halfSpan * 2 + 1;
  // Use the real DLMM bin-price formula keyed to the pool's active price so
  // the axis matches what the pool detail page shows. Falls back to a unit
  // anchor when activePrice is missing (e.g. devnet pool with no oracle) —
  // the chart shape is still correct, only the absolute labels shift.
  const activePrice = p.activePrice && p.activePrice > 0 ? p.activePrice : 1;
  const binStep = p.binStep ?? 25;
  return Array.from({ length: count }, (_, i) => {
    const binId = center - halfSpan + i;
    const d = binId - center;
    const sigma = halfSpan / 2.8;
    const liquidity = Math.exp(-(d * d) / (2 * sigma * sigma)) * 1_000_000;
    return { binId, price: binPrice(activePrice, center, binId, binStep), liquidity };
  });
}

export function PositionDetailPage({ positions }: Props) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const position = positions.find((p) => p.id === id);

  const bins = useMemo(() => (position ? buildPositionBins(position) : []), [position]);
  const center = position?.activeBinId ?? 0;
  const lower = position?.rangeLowerBin ?? center - 8;
  const upper = position?.rangeUpperBin ?? center + 8;
  const userOverlay = useMemo(
    () =>
      position && bins.length > 0
        ? projectUserShape(bins, lower, upper, position.shape ?? "spot", parseUsd(position.value) || 1)
        : [],
    [bins, lower, upper, position],
  );

  if (!position) {
    return (
      <section className="panel-shell rounded-2xl p-8 text-center">
        <p className="text-sm text-muted-foreground">Position not found.</p>
        <Link to="/portfolio" className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to portfolio
        </Link>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      {/* Top bar */}
      <button
        type="button"
        onClick={() => navigate("/portfolio")}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to portfolio
      </button>

      {/* Header */}
      <Reveal delay={0}>
      <section className="panel-shell rounded-2xl p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                {position.protocol}
              </span>
              <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Bin step {position.binStep ?? "—"}
              </span>
              <span className="rounded-full border border-border bg-secondary/70 px-2.5 py-1 text-[11px] text-muted-foreground">
                Opened {position.openedAt ?? "—"}
              </span>
              <PositionStatusPill inRange={position.inRange} closed={position.closed} size="sm" />
            </div>

            <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              {position.poolName}
            </h1>

            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="font-mono text-xs">{position.id}</span>
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(position.id)}
                className="inline-flex items-center gap-1 text-foreground transition-colors hover:text-primary"
              >
                <Copy className="h-3.5 w-3.5" /> Copy
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:w-[560px]">
            <Stat label="Value" value={position.value} />
            <Stat label="Deposited" value={position.deposited} muted />
            <Stat label="P&L" value={position.pnl ?? "—"} tone={position.pnlDirection === "down" ? "down" : "up"} />
            <Stat label="Fees" value={position.feesEarned} tone="up" />
          </div>
        </div>
      </section>
      </Reveal>

      {shouldShowDowngradeDisclosure(position) && (
        <Reveal delay={40}>
          <DowngradeDisclosureBanner />
        </Reveal>
      )}

      {/* Bin chart + claim summary */}
      <Reveal delay={80}>
      <section className="panel-shell rounded-2xl p-5 sm:p-6">
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <div className="rounded-2xl border border-border/70 bg-card/60 p-3 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-baseline gap-3">
                <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Your liquidity</span>
                <span className="font-mono text-sm text-muted-foreground">
                  {bins[0]?.binId} → {bins.at(-1)?.binId}
                </span>
              </div>
              <span className="rounded-full border border-border bg-secondary/60 px-2.5 py-1 font-mono text-xs text-muted-foreground">
                {Math.max(0, upper - lower + 1)} bins
              </span>
            </div>

            <ActivePriceLabel position={position} />

            <BinLiquidityChart
              bins={bins}
              activeBinId={center}
              range={{ lower, upper }}
              shape={position.shape ?? "spot"}
              userLiquidity={userOverlay}
              height={260}
            />
          </div>

          <ClaimSummary position={position} />
        </div>
      </section>
      </Reveal>

      {/* P&L breakdown */}
      <Reveal delay={160}>
        <PnLBreakdownPanel position={position} />
      </Reveal>

      {/* close/05 — mid-position fee claim. Placed above the action
          drawer so it stays region-disjoint from ticket 01's Close
          button (lives inside `ActionDrawer`). Only renders when the
          Position is `active`; the component self-gates. */}
      <Reveal delay={200}>
        <EarnedFeesCard position={position} positionState={position.status} />
      </Reveal>

      {/* Action drawer */}
      <Reveal delay={240}>
        <ActionDrawer position={position} bins={bins} initialLower={lower} initialUpper={upper} center={center} />
      </Reveal>
    </div>
  );
}

const QUOTE_SYMBOLS = new Set(["SOL", "USDC", "USDT"]);
const USD_QUOTES = new Set(["USDC", "USDT"]);

/**
 * Renders the position's active price the same way pool detail does:
 * `<base in quote> · ≈ $<usd> / <base>`. When the pool's quote (tokenB)
 * is a stable (USDC/USDT) we skip the USD line since it'd be a near-1:1
 * tautology. Mirrors the discovery + detail formats so the user sees the
 * same number in three places.
 */
function ActivePriceLabel({ position }: { position: PortfolioPosition }) {
  const [quoteUsd, setQuoteUsd] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    if (!position.tokenBMint) return;
    getPrices([position.tokenBMint])
      .then((prices) => {
        if (cancelled) return;
        const p = prices[position.tokenBMint!]?.usdPrice;
        if (p && p > 0) setQuoteUsd(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [position.tokenBMint]);

  const active = position.activePrice ?? 0;
  if (!Number.isFinite(active) || active <= 0) return null;

  const tokenA = position.tokenA ?? "";
  const tokenB = position.tokenB ?? "";
  const isQuote = QUOTE_SYMBOLS.has(tokenB.toUpperCase());
  const isUsdQuote = USD_QUOTES.has(tokenB.toUpperCase());

  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Active price</span>
      <span className="font-mono text-base text-foreground tabular-nums">{formatPositionPrice(active)}</span>
      {isQuote && tokenA && tokenB && (
        <span className="text-xs text-muted-foreground">
          {tokenA}/{tokenB}
        </span>
      )}
      {!isUsdQuote && quoteUsd > 0 && tokenA && (
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          ≈ {formatPositionUsd(active * quoteUsd)} / {tokenA}
        </span>
      )}
    </div>
  );
}

function formatPositionPrice(p: number): string {
  if (!Number.isFinite(p) || p === 0) return "—";
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  const magnitude = Math.floor(Math.log10(p));
  const decimals = Math.max(4, 3 - magnitude);
  return p.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

function formatPositionUsd(p: number): string {
  if (!Number.isFinite(p) || p === 0) return "$0";
  if (p >= 1000) return `$${p.toFixed(2)}`;
  if (p >= 1) return `$${p.toFixed(4)}`;
  if (p >= 0.01) return `$${p.toFixed(5)}`;
  const magnitude = Math.floor(Math.log10(p));
  const decimals = Math.max(4, 3 - magnitude);
  return `$${p.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function ClaimSummary({ position }: { position: PortfolioPosition }) {
  const claimable = parseUsd(position.claimable);
  const canClaim = position.hasClaimableFees === true;
  const { wallet } = useSolana();
  const [modalOpen, setModalOpen] = useState(false);

  const handleClaim = () => {
    if (!wallet.address) {
      toast.error("Connect your wallet to claim.");
      return;
    }
    if (!position.stealthPubkey) {
      toast.error("Stealth wallet missing on this position — re-open the deposit modal once.");
      return;
    }
    setModalOpen(true);
  };

  const disabled = !canClaim || !wallet.connected;

  return (
    <div className="flex flex-col justify-between gap-4 rounded-2xl border border-border bg-card p-5">
      <div>
        <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Earnings</p>
        <p className="mt-2 font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {position.feesEarned}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Total fees since opening</p>
      </div>

      <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
        <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Claimable now</p>
        <p
          className={`mt-1 font-mono text-xl font-semibold tabular-nums ${
            canClaim ? "text-primary" : "text-foreground/70"
          }`}
        >
          {position.claimable ?? "$0.00"}
        </p>
        {canClaim && claimable <= 0 && (
          <p className="mt-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Fees pending · USD price unavailable on devnet
          </p>
        )}
        <Button
          variant="hero"
          size="sm"
          disabled={disabled}
          onClick={handleClaim}
          className="mt-3 w-full justify-center rounded-xl"
        >
          <Coins className="h-4 w-4" />
          Claim privately
        </Button>
      </div>

      <p className="text-[11px] leading-5 text-muted-foreground">
        Fees claim to the stealth wallet, swap to SOL, then route through the mixer
        to your main wallet. Total time ~10 minutes; main wallet stays unlinked.
      </p>

      {position.stealthPubkey && (
        <PrivateClaimModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          position={{
            positionId: position.id,
            poolAddress: position.poolAddress,
            stealthPubkey: position.stealthPubkey,
            derivationVersion: position.derivationVersion,
          }}
        />
      )}
    </div>
  );
}

function shorten(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function shouldShowDowngradeDisclosure(position: PortfolioPosition): boolean {
  if (position.mode === "standard" && !position.surfaceDowngradeDisclosure) return false;
  return (
    position.surfaceDowngradeDisclosure === true ||
    (position.mode === "fast-private" && position.fallbackMode === "standard")
  );
}

function DowngradeDisclosureBanner() {
  return (
    <section
      role="status"
      aria-live="polite"
      className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 sm:p-5"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
        <div>
          <p className="text-sm font-medium text-amber-100">Position downgraded to standard mode</p>
          <p className="mt-1 text-sm leading-6 text-amber-100/85">
            Octora downgraded this Position to standard mode to keep the trade window open.
            Your origin wallet is now linked to this Position. Privacy and unlinkability are
            weaker from this point forward, but no extra approval was required to keep the
            execution moving.
          </p>
        </div>
      </div>
    </section>
  );
}

function isRecoverablePosition(position: PortfolioPosition): boolean {
  const status = position.status.toUpperCase();
  return status === "LP_FAILED" || status === "PARKED";
}

/**
 * close/01 — Private Position Close cluster states. Drives the
 * dedicated close-flow panel rendered by `ActionDrawer`; the
 * `*_FAILED` terminals route to close/03's `CloseRecoveryPanel`
 * which surfaces the user-signed close-recovery action buttons +
 * disclosure dialog.
 */
const CLOSE_FLOW_STATES = new Set([
  "CLOSING",
  "SWAPPING",
  "REMIXING",
  "CLOSED",
  "CLOSE_FAILED",
  "SWAP_FAILED",
  "REMIX_FAILED",
]);

function isCloseFlowPosition(position: PortfolioPosition): boolean {
  return CLOSE_FLOW_STATES.has(position.status.toUpperCase());
}

function isCloseFlowFailed(position: PortfolioPosition): boolean {
  const status = position.status.toUpperCase();
  return (
    status === "CLOSE_FAILED" ||
    status === "SWAP_FAILED" ||
    status === "REMIX_FAILED"
  );
}

function ActionDrawer({
  position,
  bins,
  initialLower,
  initialUpper,
  center,
}: {
  position: PortfolioPosition;
  bins: LiquidityBin[];
  initialLower: number;
  initialUpper: number;
  center: number;
}) {
  const [tab, setTab] = useState("withdraw");

  if (isRecoverablePosition(position)) {
    return (
      <section className="panel-shell rounded-2xl p-5 sm:p-6">
        <RecoveryPanel position={position} />
      </section>
    );
  }

  // close/01 — when the Position is in the Private Position Close
  // cluster (active progress through CLOSING/SWAPPING/REMIXING, the
  // CLOSED terminal, or any *_FAILED terminal), render the dedicated
  // close-flow panel instead of the standard withdraw/rebalance tabs.
  if (isCloseFlowPosition(position)) {
    return (
      <section className="panel-shell rounded-2xl p-5 sm:p-6">
        <CloseFlowPanel position={position} />
      </section>
    );
  }

  return (
    <section className="panel-shell rounded-2xl p-5 sm:p-6">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto w-full justify-start overflow-x-auto rounded-lg border border-border bg-secondary/60 p-1 sm:w-auto">
          <TabsTrigger value="withdraw" className="rounded-md px-4 py-2 text-sm data-[state=active]:bg-surface-elevated">
            <Minus className="h-3.5 w-3.5" />
            {position.closed ? "Sweep" : "Withdraw"}
          </TabsTrigger>
          {!position.closed && (
            <TabsTrigger value="rebalance" className="rounded-md px-4 py-2 text-sm data-[state=active]:bg-surface-elevated">
              <Repeat className="h-3.5 w-3.5" />
              Rebalance
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="withdraw" className="mt-5">
          {position.closed ? (
            <SweepPanel position={position} />
          ) : (
            <WithdrawPanel position={position} />
          )}
        </TabsContent>
        {!position.closed && (
          <TabsContent value="rebalance" className="mt-5">
            <RebalancePanel
              position={position}
              bins={bins}
              initialLower={initialLower}
              initialUpper={initialUpper}
              center={center}
            />
          </TabsContent>
        )}
      </Tabs>
    </section>
  );
}

/**
 * close/01 — progress + recovery panel for a Position inside the
 * Private Position Close cluster. Reflects each transition with an
 * honest label; on `*_FAILED` terminals renders the `CloseRecoveryStub`
 * placeholder until close/03 lands the user-signed action button.
 */
function CloseFlowPanel({ position }: { position: PortfolioPosition }) {
  const status = position.status.toUpperCase();
  const failed = isCloseFlowFailed(position);

  const steps: Array<{ key: string; label: string; state: "done" | "active" | "pending" }> = [
    {
      key: "CLOSING",
      label: "Closing position on Meteora",
      state: stepState(status, "CLOSING"),
    },
    {
      key: "SWAPPING",
      label: "Swapping residual to SOL (skipped when no non-SOL residue)",
      state: stepState(status, "SWAPPING"),
    },
    {
      key: "REMIXING",
      label: "Re-mixing into anonymity set",
      state: stepState(status, "REMIXING"),
    },
    {
      key: "CLOSED",
      label: "Closed privately — fresh Commitment landed",
      state: stepState(status, "CLOSED"),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4 sm:p-5">
        <p className="text-[11px] uppercase tracking-[0.22em] text-primary/80">
          Private Position Close
        </p>
        <p className="mt-2 text-sm leading-6 text-foreground">
          {status === "CLOSED"
            ? "This Position has been closed privately. One denomination of SOL is now a fresh anonymity-set entry — withdraw it later to a new recipient from the mixer."
            : failed
              ? "A step in the close flow did not land. Pick a recovery path below."
              : "Three relayer-signed transactions, serial: dlmm_withdraw_close → (optional) dlmm_swap → mixer.deposit."}
        </p>
      </div>

      <ol className="space-y-2">
        {steps.map((step) => (
          <li
            key={step.key}
            className={`flex items-center gap-3 rounded-xl border p-3 ${
              step.state === "active"
                ? "border-primary/60 bg-primary/5"
                : step.state === "done"
                  ? "border-border bg-card"
                  : "border-border/60 bg-card/40 opacity-70"
            }`}
          >
            {step.state === "active" ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            ) : step.state === "done" ? (
              <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-primary" />
            ) : (
              <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-border" />
            )}
            <p className="text-sm leading-5">{step.label}</p>
          </li>
        ))}
      </ol>

      {failed && <CloseRecoveryPanel position={position} />}
    </div>
  );
}

function stepState(
  current: string,
  step: "CLOSING" | "SWAPPING" | "REMIXING" | "CLOSED",
): "done" | "active" | "pending" {
  const order = ["CLOSING", "SWAPPING", "REMIXING", "CLOSED"];
  const idxCurrent = order.indexOf(current);
  const idxStep = order.indexOf(step);
  if (idxCurrent === -1) return "pending";
  if (idxCurrent === idxStep) return "active";
  if (idxStep < idxCurrent) return "done";
  return "pending";
}

/**
 * close/03 — user-signed close-recovery panel rendered on any
 * `CLOSE_FAILED` / `SWAP_FAILED` / `REMIX_FAILED` terminal. Mirrors
 * dust/04's `RecoveryPanel` (Flow 1+2) but offers the close-flow's
 * two distinct recovery paths:
 *   - "Complete close" — sign the remaining leg(s) and let the
 *     Position settle at `CLOSED`.
 *   - "Bail to withdraw" — sign a direct withdraw and roll the close
 *     back into `WITHDRAWN`.
 *
 * Caveat (mirrors dust/04): Positions whose close was kicked off
 * before this commit shipped have no `closeWitness`. They fall back
 * to the legacy stealth-sweep `RecoveryPanel` (Flow 1+2's UI) — same
 * pattern dust/04 used for pre-witness Positions.
 */
function CloseRecoveryPanel({ position }: { position: PortfolioPosition }) {
  const { wallet } = useSolana();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const status = position.status.toUpperCase();

  const [pending, setPending] = useState(false);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pendingAction, setPendingAction] = useState<CloseRecoveryAction>("bail-to-withdrawn");

  // Caveat — Positions closed before close/03 shipped have no
  // `closeWitness`. Fall back to the legacy stealth-sweep `SweepPanel`
  // so funds are never *truly* stuck just because the witness blob is
  // missing.
  const stored = wallet.address
    ? listLocalPositions(wallet.address).find((p) => p.positionId === position.id)
    : undefined;
  const hasWitness = !!stored?.closeWitness;

  if (!hasWitness) {
    return (
      <div className="space-y-3">
        <div
          role="alert"
          aria-live="polite"
          className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 sm:p-5"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div>
              <p className="text-sm font-medium text-amber-100">
                Recovery available via stealth-sweep fallback ({status})
              </p>
              <p className="mt-1 text-sm leading-6 text-amber-100/85">
                This Position's close was kicked off before close/03 shipped, so the
                in-browser close-recovery witness is missing. The legacy
                stealth-sweep path below still recovers any funds parked at the
                Stealth Wallet — same caveat dust/04 carries for pre-witness deposits.
              </p>
            </div>
          </div>
        </div>
        <SweepPanel position={position} />
      </div>
    );
  }

  const openDisclosure = (action: CloseRecoveryAction) => {
    if (!wallet.address) {
      toast.error("Connect your origin wallet to recover funds.");
      return;
    }
    setPendingAction(action);
    setAcknowledged(false);
    setDisclosureOpen(true);
  };

  const executeRecovery = async () => {
    if (!wallet.address || !stored) {
      toast.error("Connect your origin wallet to recover funds.");
      return;
    }
    setDisclosureOpen(false);
    setPending(true);
    const t = toast.loading("Broadcasting user-signed close-recovery…");
    try {
      const res = await runUserSignedCloseRecovery({
        mainWalletAddress: wallet.address,
        position: stored,
        recoveryAction: pendingAction,
      });

      // Mirror the local lifecycle state so the UI doesn't need to wait
      // for the backend's state-machine flip to come back.
      if (res.finalState === "WITHDRAWN") {
        markLocalPositionWithdrawn(wallet.address, position.id, {
          signature: res.signature,
          recipient: res.recipient,
        });
      } else {
        markLocalPositionClosed(wallet.address, position.id, {
          signature: res.signature,
          recipient: res.recipient,
        });
      }

      toast.success(
        res.finalState === "CLOSED"
          ? "Close completed via user-signed recovery."
          : "Funds recovered to your destination.",
        { id: t, description: res.signature ? shorten(res.signature) : undefined },
      );
      queryClient.invalidateQueries({ queryKey: ["positions"] });
    } catch (err) {
      if (err instanceof MissingCloseWitnessError) {
        toast.error(err.message, { id: t });
      } else {
        toast.error(err instanceof Error ? err.message : String(err), { id: t });
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-4">
      <div
        role="alert"
        aria-live="polite"
        className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 sm:p-5"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <div>
            <p className="text-sm font-medium text-amber-100">
              Close flow stopped at {status} — pick a recovery path
            </p>
            <p className="mt-1 text-sm leading-6 text-amber-100/85">
              Funds are not lost. Sign the recovery transaction(s) yourself to
              either complete the close (a fresh Commitment lands in the Mixer
              Pool) or bail out to a direct withdraw (funds go to a destination
              you control). Both paths break unlinkability for this Position —
              the origin wallet → destination link becomes visible on-chain.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <RecoveryAction
          variant="subtle"
          title="Complete close"
          subtitle="Breaks unlinkability"
          detail="Sign the remaining leg(s) yourself. The close lands at CLOSED — a fresh Commitment goes into the Mixer Pool, ready for a private withdraw later. Origin wallet is the signer for the remaining txs."
          onClick={() => openDisclosure("complete-close")}
          disabled={pending || !wallet.connected}
        />
        <RecoveryAction
          variant="hero"
          icon={pending ? <Loader2 className="animate-spin" /> : undefined}
          title="Bail to withdraw"
          subtitle="Breaks unlinkability"
          detail="Skip the re-mix. Sign a direct withdraw of any stealth-held funds to your origin wallet. Fastest path but no fresh Commitment is created — the close is rolled back."
          onClick={() => openDisclosure("bail-to-withdrawn")}
          disabled={pending || !wallet.connected}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/portfolio")}
          className="rounded-xl"
        >
          <ExternalLink className="h-4 w-4" />
          Portfolio
        </Button>
      </div>

      <UserSignedCloseRecoveryDialog
        open={disclosureOpen}
        onOpenChange={setDisclosureOpen}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onConfirm={executeRecovery}
        recoveryAction={pendingAction}
        recipient={wallet.address ?? undefined}
        pending={pending}
      />
    </div>
  );
}

/**
 * Pre-sign disclosure dialog for the close/03 user-signed
 * close-recovery path. Mirrors `UserSignedRecoveryDialog` (dust/04)
 * but the disclosure copy is specific to the Flow 3 close-flow and
 * carries the `recoveryAction` so the body explains the right
 * trade-off.
 */
function UserSignedCloseRecoveryDialog({
  open,
  onOpenChange,
  acknowledged,
  onAcknowledgedChange,
  onConfirm,
  recoveryAction,
  recipient,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  acknowledged: boolean;
  onAcknowledgedChange: (v: boolean) => void;
  onConfirm: () => void;
  recoveryAction: CloseRecoveryAction;
  recipient?: string;
  pending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-300" />
            {recoveryAction === "complete-close"
              ? "Complete the close yourself"
              : "Bail to a direct withdraw"}
          </DialogTitle>
          <DialogDescription>
            This path is the worst-case-but-always-available recovery for a
            Position whose close did not settle. It works even if Octora's
            relayer is offline — the origin wallet signs the recovery tx(s)
            directly and broadcasts to RPC.
          </DialogDescription>
        </DialogHeader>

        <UserSignedCloseRecoveryDisclosure
          acknowledged={acknowledged}
          onAcknowledgedChange={onAcknowledgedChange}
          recoveryAction={recoveryAction}
          recipient={recoveryAction === "bail-to-withdrawn" ? recipient : undefined}
        />

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="hero"
            onClick={onConfirm}
            disabled={!acknowledged || pending}
          >
            {pending ? <Loader2 className="animate-spin" /> : null}
            Sign and broadcast
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecoveryPanel({ position }: { position: PortfolioPosition }) {
  const { wallet } = useSolana();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const handleRetry = () => {
    if (wallet.address) {
      markLocalPositionLifecycleStatus(wallet.address, position.id, "LP_FAILED");
    }
    navigate(`/pool/${position.poolAddress}`);
  };

  const handlePark = () => {
    if (!wallet.address) {
      toast.error("Connect your origin wallet to park this Position.");
      return;
    }
    markLocalPositionLifecycleStatus(wallet.address, position.id, "PARKED");
    toast.message("Position parked", {
      description: "Funds stay recoverable from this Position. Resume from the pool when ready.",
    });
  };

  /**
   * Open the disclosure dialog. The actual signing happens in
   * `executeUserSignedRecovery` after the user acknowledges that the
   * origin wallet → withdraw destination link becomes observable
   * on-chain (the dust/04 / ADR-0004 trade-off).
   */
  const handleRecover = () => {
    if (!wallet.address) {
      toast.error("Connect your origin wallet to recover funds.");
      return;
    }
    setAcknowledged(false);
    setDisclosureOpen(true);
  };

  /**
   * Runs the dust/04 user-signed Recover Funds flow once the
   * disclosure has been acknowledged.
   *
   * Tries the new `runUserSignedRecovery` first — it builds, signs, and
   * broadcasts a `mixer.withdraw` directly to RPC without touching the
   * backend relayer. Falls back to the legacy stealth-sweep when the
   * Position lacks a persisted mixer-withdraw witness (older deposits,
   * non-mixer flows). The fallback still recovers funds — it's
   * stealth → main rather than mixer → main — and the disclosure
   * already covered the linkability trade-off either way.
   */
  const executeUserSignedRecovery = async () => {
    if (!wallet.address) {
      toast.error("Connect your origin wallet to recover funds.");
      return;
    }

    setDisclosureOpen(false);
    setPending(true);
    const t = toast.loading("Building user-signed recovery transaction...");
    try {
      const stored = listLocalPositions(wallet.address).find(
        (p) => p.positionId === position.id,
      );

      if (stored?.mixerWithdrawWitness) {
        const res = await runUserSignedRecovery({
          mainWalletAddress: wallet.address,
          position: stored,
        });
        markLocalPositionWithdrawn(wallet.address, position.id, {
          signature: res.signature,
          recipient: res.recipient,
        });
        toast.success("Recovery submitted", {
          id: t,
          description: shorten(res.signature),
        });
        return;
      }

      // Legacy fallback — Position has no mixer witness (pre-dust/04
      // deposit, or LP_FAILED *after* a successful relayer.withdraw).
      // Sweep the stealth wallet's residual balance straight to main.
      // Throws `MissingWithdrawWitnessError` is impossible here (we just
      // checked) — leaving the catch for future signal.
      if (!position.stealthPubkey) {
        throw new Error(
          "Position has no mixer-withdraw witness and no stealth address — recovery requires at least one.",
        );
      }
      const res = await runSweepStealthToMain({
        mainWalletAddress: wallet.address,
        poolAddress: position.poolAddress,
        positionId: position.derivationVersion === "v2" ? position.id : undefined,
      });
      markLocalPositionWithdrawn(wallet.address, position.id, {
        signature: res.signature ?? undefined,
        recipient: res.recipient,
      });
      toast.success("Recovery submitted", {
        id: t,
        description: res.signature
          ? shorten(res.signature)
          : "Nothing transferable remained at the stealth wallet.",
      });
    } catch (err) {
      if (err instanceof MissingWithdrawWitnessError) {
        toast.error(err.message, { id: t });
      } else {
        toast.error(err instanceof Error ? err.message : String(err), { id: t });
      }
    } finally {
      setPending(false);
    }
  };

  const copyStealth = () => {
    if (!position.stealthPubkey) return;
    navigator.clipboard?.writeText(position.stealthPubkey);
    toast.success("Stealth address copied.");
  };

  const isParked = position.status.toUpperCase() === "PARKED";

  return (
    <div className="space-y-5">
      <div
        role="alert"
        aria-live="polite"
        className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 sm:p-5"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <div>
            <p className="text-sm font-medium text-amber-100">
              {isParked
                ? "Position parked — funds still recoverable"
                : "Add liquidity didn't settle — pick a recovery path"}
            </p>
            <p className="mt-1 text-sm leading-6 text-amber-100/85">
              {isParked
                ? "Your private deposit is on the Mixer Pool and we still hold the persisted intent (nullifier hash, pool, denomination). Resume to retry the same private route, or recover funds with a user-signed withdraw — the latter links your origin wallet to the destination on-chain."
                : "Your private deposit confirmed but the add-liquidity leg didn't land. Pick one of the three paths below — each has a different privacy trade-off."}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {/* Retry / Resume — preserves full privacy. */}
        <RecoveryAction
          variant="subtle"
          icon={<Repeat className="h-4 w-4" />}
          title={isParked ? "Resume in pool" : "Retry private LP"}
          subtitle="Privacy intact"
          detail={
            isParked
              ? "Re-arm the user-signed withdraw + add_liquidity. Stealth Wallet identity preserved; origin wallet stays unlinked."
              : "Re-attempt the same withdraw + add_liquidity from the Stealth Wallet. No on-chain link to your origin wallet."
          }
          onClick={handleRetry}
          disabled={false}
        />
        {/* Park — neutral, persisted intent survives. */}
        <RecoveryAction
          variant="ghost"
          title="Park for later"
          subtitle="Privacy intact"
          detail="Leaves the persisted deposit intent in place. Funds remain recoverable from this Position. Resume from the pool when ready."
          onClick={handlePark}
          disabled={!wallet.connected || isParked}
        />
        {/* Withdraw (dust/04 path) — links origin wallet to destination. */}
        <RecoveryAction
          variant="hero"
          icon={pending ? <Loader2 className="animate-spin" /> : undefined}
          title="Recover funds"
          subtitle="Breaks unlinkability"
          detail="User-signed withdraw straight to a destination you control. Works even if our relayer is offline, but the origin wallet → destination link is visible on-chain."
          onClick={handleRecover}
          disabled={pending || !wallet.connected || !position.stealthPubkey}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={copyStealth}
          disabled={!position.stealthPubkey}
          className="rounded-xl"
        >
          <Copy className="h-4 w-4" />
          Copy stealth
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/portfolio")}
          className="rounded-xl"
        >
          <ExternalLink className="h-4 w-4" />
          Portfolio
        </Button>
      </div>

      <UserSignedRecoveryDialog
        open={disclosureOpen}
        onOpenChange={setDisclosureOpen}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
        onConfirm={executeUserSignedRecovery}
        recipient={wallet.address ?? undefined}
        pending={pending}
      />
    </div>
  );
}

/**
 * Pre-sign disclosure dialog for the dust/04 user-signed Recover
 * Funds path. Same disclosure pattern as ADR-0001's Mode Fallback
 * banner, except this one is gated *before* signing (the user is the
 * one initiating the trade-off).
 *
 * Confirms two things:
 *   1. The recovery path bypasses Octora's relayer entirely — it works
 *      even if the relayer service is down.
 *   2. The recovery transaction makes the origin wallet linkable to
 *      the withdraw destination on-chain (ADR-0002 invariant the other
 *      way: the origin wallet is the only thing that can decrypt the
 *      stealth seed, so its signature here is the price of recovery).
 */
function UserSignedRecoveryDialog({
  open,
  onOpenChange,
  acknowledged,
  onAcknowledgedChange,
  onConfirm,
  recipient,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  acknowledged: boolean;
  onAcknowledgedChange: (v: boolean) => void;
  onConfirm: () => void;
  recipient?: string;
  pending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-300" />
            Recover funds with a user-signed withdraw
          </DialogTitle>
          <DialogDescription>
            This path is the worst-case-but-always-available recovery for a
            Position whose private add-liquidity leg did not settle. It works
            even if Octora's relayer is offline — the origin wallet signs the
            mixer withdraw directly and broadcasts it to RPC.
          </DialogDescription>
        </DialogHeader>

        <UserSignedRecoveryDisclosure
          acknowledged={acknowledged}
          onAcknowledgedChange={onAcknowledgedChange}
          recipient={recipient}
        />

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            variant="hero"
            onClick={onConfirm}
            disabled={!acknowledged || pending}
          >
            {pending ? <Loader2 className="animate-spin" /> : null}
            Sign and broadcast
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Per-button card for the LP_FAILED / PARKED recovery panel. Pulls the
 * privacy implication out of a tooltip and into a visible "Privacy
 * intact" / "Breaks unlinkability" subtitle so users see the trade-off
 * before they click. Mirrors the disclosure invariant in
 * `DowngradeDisclosureBanner`: never hide a privacy regression behind
 * a single button label.
 */
function RecoveryAction({
  variant,
  icon,
  title,
  subtitle,
  detail,
  onClick,
  disabled,
}: {
  variant: "hero" | "subtle" | "ghost";
  icon?: React.ReactNode;
  title: string;
  subtitle: "Privacy intact" | "Breaks unlinkability";
  detail: string;
  onClick: () => void;
  disabled: boolean;
}) {
  const subtitleTone =
    subtitle === "Privacy intact" ? "text-primary" : "text-amber-300";
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card/40 p-3">
      <Button
        variant={variant}
        size="lg"
        onClick={onClick}
        disabled={disabled}
        className="w-full justify-center rounded-xl"
      >
        {icon}
        {title}
      </Button>
      <p className={`text-[10px] uppercase tracking-[0.18em] ${subtitleTone}`}>
        {subtitle}
      </p>
      <p className="text-[11px] leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}

function WithdrawPanel({ position }: { position: PortfolioPosition }) {
  const { wallet } = useSolana();
  const [modalOpen, setModalOpen] = useState(false);
  const [closePending, setClosePending] = useState(false);
  // close/02 — pre-flight quote + confirmation modal state.
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [closeQuote, setCloseQuote] = useState<
    Extract<CloseQuoteResponse, { closeable: true }> | null
  >(null);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const queryClient = useQueryClient();
  const isActive = position.status.toLowerCase() === "active";
  // close/04 — disable the Close button entirely when the backend's
  // pre-flight gate already refused (e.g. unsupported_mint).
  const canClose = useCanClosePosition(position.id);
  const closeBlocked = canClose.closeable === false;

  const handleWithdraw = () => {
    if (!wallet.address) {
      toast.error("Connect your wallet to withdraw.");
      return;
    }
    if (!position.stealthPubkey) {
      toast.error("Stealth wallet missing on this position — re-open the deposit modal once.");
      return;
    }
    setModalOpen(true);
  };

  /**
   * close/02 — intercept the Close button click, fetch the pre-flight
   * `GET /close-quote`, then open the confirmation modal. The actual
   * `POST /close` runs from `handleCloseConfirm` once the user accepts
   * the slippage tolerance.
   *
   * close/03 — the `closeWitness` persistence (for the user-signed
   * recovery path) is wired into `handleCloseConfirm` once the backend
   * confirms the orchestrator started; see that handler below.
   */
  const handleCloseClick = async () => {
    if (!wallet.address) {
      toast.error("Connect your wallet to close this position.");
      return;
    }
    if (!isActive) {
      toast.error(`Position must be active to close (current: ${position.status}).`);
      return;
    }
    setQuoteLoading(true);
    const t = toast.loading("Fetching close preview…");
    try {
      const res = await fetch(`/positions/${position.id}/close-quote`);
      if (!res.ok) {
        throw new Error(`close-quote failed: ${res.status}`);
      }
      const body = (await res.json()) as CloseQuoteResponse;
      if (body.closeable === false) {
        toast.error(
          `Close blocked: ${body.reason}${
            body.details?.extension ? ` (${body.details.extension})` : ""
          }`,
          { id: t },
        );
        return;
      }
      setCloseQuote(body);
      setCloseConfirmOpen(true);
      toast.dismiss(t);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { id: t });
    } finally {
      setQuoteLoading(false);
    }
  };

  /**
   * close/02 — fired by the modal once the user confirms slippage.
   * Posts `{ slippageBps, expectedSwapOutLamports }` to `/close`; the
   * backend's adapter computes `min_amount_out` and threads it into the
   * `dlmm_swap` ix.
   */
  const handleCloseConfirm = async (input: {
    slippageBps: number;
    expectedSwapOutLamports: string | null;
  }) => {
    if (!wallet.address) return;
    setClosePending(true);
    const t = toast.loading("Closing position privately…");
    try {
      const res = await fetch(`/positions/${position.id}/close`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-wallet-address": wallet.address,
        },
        body: JSON.stringify({
          slippageBps: input.slippageBps,
          ...(input.expectedSwapOutLamports
            ? { expectedSwapOutLamports: input.expectedSwapOutLamports }
            : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `Close failed: ${res.status}`);
      }

      // close/03 — write the close witness only once the backend has
      // confirmed the orchestrator started. Writing before the POST
      // would mean a witness blob for a Position that never actually
      // entered the close cluster (e.g. a 4xx from the backend).
      if (position.stealthPubkey) {
        recordCloseWitness(wallet.address, position.id, {
          poolAddress: position.poolAddress,
          stealthPubkey: position.stealthPubkey,
          positionPubkey: position.stealthPubkey, // best available pubkey on PortfolioPosition
          otherSideMint: position.tokenBMint ?? undefined,
          denominationLamports: "1000000000", // MVP single-sided SOL denomination
          expectedSolLamports: undefined,
          expectedOtherSideLamports: undefined,
          // close/06 — persist the slippage the user accepted so the
          // user-signed swap recovery can re-apply the same min_amount_out
          // when the orchestrator-driven leg lands in SWAP_FAILED.
          slippageBps: input.slippageBps,
          expectedSwapOutLamports: input.expectedSwapOutLamports ?? undefined,
          ts: Date.now(),
        });
      }

      toast.success("Close complete — re-mixed into the anonymity set.", { id: t });
      queryClient.invalidateQueries({ queryKey: ["positions"] });
      setCloseConfirmOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { id: t });
    } finally {
      setClosePending(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label="Receive" value={position.value} />
        <Stat label="Execution" value="Private route" muted />
      </div>

      <Button
        variant="hero"
        size="lg"
        className="w-full justify-center rounded-xl"
        onClick={handleWithdraw}
        disabled={!wallet.connected}
      >
        Exit privately
        <ArrowRight />
      </Button>
      <p className="text-xs leading-5 text-muted-foreground">
        Close the position, swap residue to SOL, then route through the mixer to
        your main wallet. ~10 minutes end-to-end; no on-chain link between the
        stealth that held the position and the main wallet that receives the SOL.
      </p>

      {/* close/01 — Private Position Close (relayer-driven mainline) */}
      <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4 sm:p-5">
        <p className="text-[11px] uppercase tracking-[0.22em] text-primary/80">
          Private re-mix close
        </p>
        <p className="mt-2 text-sm leading-6 text-foreground">
          Close the DLMM Position, swap any non-SOL residue to SOL, then re-mix
          one denomination back into the Mixer Pool as a fresh Commitment. The
          link between this Position's deposit and any future withdraw stays
          inside the Merkle tree.
        </p>
        <Button
          variant="subtle"
          size="lg"
          className="mt-3 w-full justify-center rounded-xl"
          onClick={handleCloseClick}
          disabled={
            !wallet.connected ||
            !isActive ||
            closePending ||
            quoteLoading ||
            closeBlocked
          }
          title={
            closeBlocked
              ? `Close is not yet available for pools that include ${
                  canClose.extension ?? "this"
                } mints. This is a v2 capability.`
              : undefined
          }
        >
          {closePending || quoteLoading ? <Loader2 className="animate-spin" /> : null}
          {closePending
            ? "Closing…"
            : quoteLoading
              ? "Loading preview…"
              : "Close + re-mix"}
        </Button>
        {!isActive && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Close button is only available while the Position is `active`. Current
            state: {position.status}.
          </p>
        )}
        {closeBlocked && (
          <p className="mt-2 text-[11px] text-amber-300">
            Close is not yet available for pools that include{" "}
            {canClose.extension ?? "this"} mints. This is a v2 capability.
          </p>
        )}
      </div>

      {closeQuote && (
        <CloseConfirmDialog
          open={closeConfirmOpen}
          onOpenChange={setCloseConfirmOpen}
          quote={closeQuote}
          onConfirm={handleCloseConfirm}
          pending={closePending}
        />
      )}

      {position.stealthPubkey && (
        <PrivateExitModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          position={{
            positionId: position.id,
            poolAddress: position.poolAddress,
            stealthPubkey: position.stealthPubkey,
            lowerBinId: position.rangeLowerBin ?? 0,
            upperBinId: position.rangeUpperBin ?? 0,
            depositedUsd: parseUsd(position.deposited),
            derivationVersion: position.derivationVersion,
          }}
        />
      )}
    </div>
  );
}

const SWEEP_RPC_URL =
  (import.meta.env.VITE_RPC_URL as string | undefined) ?? "https://api.devnet.solana.com";

function SweepPanel({ position }: { position: PortfolioPosition }) {
  const { wallet } = useSolana();
  const navigate = useNavigate();
  const [pendingDirect, setPendingDirect] = useState(false);
  const [pendingPrivate, setPendingPrivate] = useState(false);

  // Live stealth balance. Polled so the user can see the funds land after
  // close, and watch the row drop to ~0 after a sweep without a manual reload.
  const balanceQuery = useQuery({
    queryKey: ["stealth-balance", position.stealthPubkey],
    enabled: !!position.stealthPubkey,
    queryFn: async () => {
      const conn = new Connection(SWEEP_RPC_URL, "confirmed");
      const lamports = await conn.getBalance(new PublicKey(position.stealthPubkey!), "confirmed");
      return BigInt(lamports);
    },
    staleTime: 5_000,
    refetchInterval: 8_000,
  });

  const lamports = balanceQuery.data ?? 0n;
  const sol = Number(lamports) / 1e9;
  // Mirrors STEALTH_SWEEP_FEE_LAMPORTS in privateLifecycle.ts. After a clean
  // sweep the stealth account is reaped (0 lamports); any non-zero residue
  // below the sig-fee floor means there's nothing transferable left.
  const swept = lamports <= 5_000n;

  const handleDirect = async () => {
    if (!wallet.address) {
      toast.error("Connect your wallet to sweep.");
      return;
    }
    setPendingDirect(true);
    const t = toast.loading("Sweeping stealth → main wallet…");
    try {
      const res = await runSweepStealthToMain({
        mainWalletAddress: wallet.address,
        poolAddress: position.poolAddress,
        // Threading positionId for v2 positions so the sweep derives the
        // right stealth. v1 positions (missing the flag) fall back to
        // per-pool derive inside privateLifecycle.
        positionId:
          position.derivationVersion === "v2" ? position.id : undefined,
      });
      if (res.signature == null) {
        toast.message("Nothing to sweep — stealth balance is already at the floor.", { id: t });
      } else {
        toast.success(
          `Swept ${(Number(res.sweptLamports) / 1e9).toFixed(6)} SOL → ${shorten(res.recipient)}`,
          { id: t, description: shorten(res.signature) },
        );
      }
      // Position is fully wound down: drop the local entry and head back to
      // the portfolio. The hook's storage listener will refresh the list.
      removeLocalPosition(wallet.address, position.id);
      navigate("/portfolio");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { id: t });
    } finally {
      setPendingDirect(false);
    }
  };

  const handlePrivate = async () => {
    if (!wallet.address) {
      toast.error("Connect your wallet to exit privately.");
      return;
    }
    setPendingPrivate(true);
    try {
      await runPrivateExitToMain({
        mainWalletAddress: wallet.address,
        poolAddress: position.poolAddress,
      });
    } catch (err) {
      // Currently always throws — surface as info rather than an error so the
      // CTA reads as "coming soon" instead of "broken".
      toast.message("Private exit not implemented yet", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPendingPrivate(false);
    }
  };

  const stealthShort = position.stealthPubkey ? shorten(position.stealthPubkey) : "—";

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 sm:p-5">
        <p className="text-[11px] uppercase tracking-[0.22em] text-amber-300">Position closed · funds at stealth</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Withdraw landed on chain. Tokens + reclaimed rent now sit at the stealth wallet you derived
          for this pool. Pick how to recover them.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Stealth balance" value={`${sol.toFixed(6)} SOL`} />
        <Stat
          label="Stealth address"
          value={stealthShort}
          muted
        />
        <Stat
          label="Status"
          value={swept ? "Already swept" : "Awaiting sweep"}
          tone={swept ? undefined : "up"}
        />
      </div>

      {position.stealthPubkey && (
        <StealthAddressDisplay pubkey={position.stealthPubkey} />
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Option 1 — direct sweep, link-revealing */}
        <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Direct sweep</p>
          <p className="mt-2 text-sm leading-6 text-foreground">
            Send the stealth wallet's SOL straight to your connected main wallet. Single tx, no
            mixer round-trip — fastest, but creates an on-chain link
            <span className="font-mono"> stealth → main</span>.
          </p>
          <Button
            variant="hero"
            size="lg"
            className="mt-4 w-full justify-center rounded-xl"
            onClick={handleDirect}
            disabled={pendingDirect || !wallet.connected || swept || balanceQuery.isLoading}
          >
            {pendingDirect ? <Loader2 className="animate-spin" /> : null}
            {pendingDirect
              ? "Sweeping…"
              : swept
                ? "Already swept"
                : `Sweep ${sol.toFixed(4)} SOL to main`}
            {!pendingDirect && !swept && <ArrowRight />}
          </Button>
        </div>

        {/* Option 2 — mixer round-trip, currently a stub */}
        <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4 sm:p-5">
          <p className="text-xs uppercase tracking-[0.22em] text-primary/80">Private exit</p>
          <p className="mt-2 text-sm leading-6 text-foreground">
            Mirror of the deposit: stealth → mixer → relayer → main wallet. Breaks the
            <span className="font-mono"> stealth → main</span> link the way the deposit broke
            <span className="font-mono"> main → stealth</span>. Implementation coming next.
          </p>
          <Button
            variant="subtle"
            size="lg"
            className="mt-4 w-full justify-center rounded-xl"
            onClick={handlePrivate}
            disabled={pendingPrivate || !wallet.connected || swept}
          >
            {pendingPrivate ? <Loader2 className="animate-spin" /> : null}
            Private exit (coming soon)
          </Button>
        </div>
      </div>

      {balanceQuery.isError && (
        <p className="text-xs text-destructive">
          Couldn't read stealth balance: {(balanceQuery.error as Error).message}
        </p>
      )}
    </div>
  );
}

function RebalancePanel({
  position,
  bins,
  initialLower,
  initialUpper,
  center,
}: {
  position: PortfolioPosition;
  bins: LiquidityBin[];
  initialLower: number;
  initialUpper: number;
  center: number;
}) {
  const { wallet } = useSolana();
  const [range, setRange] = useState({ lower: initialLower, upper: initialUpper });
  const [shape, setShape] = useState<DistributionShape>(position.shape ?? "spot");
  const [modalOpen, setModalOpen] = useState(false);

  // If position drifted out of range, propose recentering on active bin by default.
  useEffect(() => {
    if (position.inRange === false) {
      const span = Math.max(8, initialUpper - initialLower);
      setRange({ lower: center - Math.floor(span / 2), upper: center + Math.ceil(span / 2) });
    }
  }, [position.inRange, center, initialLower, initialUpper]);

  const value = parseUsd(position.value);
  const overlay = useMemo(() => projectUserShape(bins, range.lower, range.upper, shape, value || 1), [
    bins,
    range,
    shape,
    value,
  ]);

  const movedLower = range.lower !== initialLower;
  const movedUpper = range.upper !== initialUpper;
  const reshape = shape !== (position.shape ?? "spot");
  const dirty = movedLower || movedUpper || reshape;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">New range</p>
            <p className="mt-1 font-display text-lg font-semibold tracking-tight text-foreground">
              Drag the handles to redraw your range
            </p>
          </div>
          {position.inRange === false && (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-400">
              Recenter suggested
            </span>
          )}
        </div>

        <BinLiquidityChart
          bins={bins}
          activeBinId={center}
          range={range}
          shape={shape}
          userLiquidity={overlay}
          onRangeChange={setRange}
          height={220}
        />

        <div className="mt-4">
          <p className="mb-2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Distribution</p>
          <DistributionPreset value={shape} onChange={setShape} />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">What changes</p>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            <Diff
              label="Lower bin"
              before={String(initialLower)}
              after={String(range.lower)}
              changed={movedLower}
            />
            <Diff
              label="Upper bin"
              before={String(initialUpper)}
              after={String(range.upper)}
              changed={movedUpper}
            />
            <Diff
              label="Shape"
              before={position.shape ?? "spot"}
              after={shape}
              changed={reshape}
            />
            <Diff
              label="Bins covered"
              before={String(initialUpper - initialLower + 1)}
              after={String(range.upper - range.lower + 1)}
              changed={range.upper - range.lower !== initialUpper - initialLower}
            />
          </ul>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Bundle</p>
          <p className="mt-2 text-sm leading-6 text-foreground">
            Withdraw from the old range and redeposit into the new one — settled as a single private bundle so the
            position never appears uncovered to observers.
          </p>
          <Row label="Notional" value={position.value} />
          <Row label="Execution" value="Single private bundle" />
          <Button
            variant="hero"
            size="lg"
            disabled={!dirty || !wallet.address || !position.stealthPubkey}
            onClick={() => {
              if (!wallet.address) {
                toast.error("Connect your wallet to rebalance.");
                return;
              }
              if (!position.stealthPubkey) {
                toast.error("Stealth wallet missing — re-open the deposit modal once.");
                return;
              }
              setModalOpen(true);
            }}
            className="mt-3 w-full justify-center rounded-xl"
          >
            Rebalance privately
            <ArrowRight />
          </Button>
          {!dirty && (
            <p className="mt-2 text-[11px] text-muted-foreground">No changes yet — drag a handle or pick a different shape.</p>
          )}
        </div>
      </div>
      {position.stealthPubkey && (
        <PrivateRebalanceModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          position={{
            positionId: position.id,
            poolAddress: position.poolAddress,
            stealthPubkey: position.stealthPubkey,
            lowerBinId: initialLower,
            upperBinId: initialUpper,
            shape: position.shape ?? "spot",
            depositedUsd: position.depositedUsd ?? parseUsd(position.deposited),
            derivationVersion: position.derivationVersion,
          }}
          newLowerBinId={range.lower}
          newUpperBinId={range.upper}
          newShape={shape}
        />
      )}
    </div>
  );
}

function Diff({ label, before, after, changed }: { label: string; before: string; after: string; changed: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3 border-b border-border/70 pb-2 last:border-b-0 last:pb-0">
      <span className="text-sm">{label}</span>
      <span className="flex items-center gap-2 font-mono text-xs tabular-nums">
        <span className="text-muted-foreground line-through">{before}</span>
        <ArrowRight className="h-3 w-3 text-muted-foreground" />
        <span className={changed ? "text-primary" : "text-foreground"}>{after}</span>
      </span>
    </li>
  );
}

function Stat({
  label,
  value,
  tone,
  muted,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
  muted?: boolean;
}) {
  const color =
    tone === "up"
      ? "text-primary"
      : tone === "down"
      ? "text-destructive"
      : muted
      ? "text-muted-foreground"
      : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
      <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground sm:text-xs">{label}</p>
      <p className={`mt-1.5 font-mono text-base font-semibold tabular-nums sm:text-lg ${color}`}>{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-3 flex items-center justify-between gap-3 border-b border-border/80 pb-3 last:border-b-0 last:pb-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-mono text-sm font-medium tabular-nums text-foreground">{value}</span>
    </div>
  );
}
