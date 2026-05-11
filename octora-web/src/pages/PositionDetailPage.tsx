import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Coins, Copy, Loader2, Minus, Repeat } from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Connection, PublicKey } from "@solana/web3.js";

import type { DistributionShape, LiquidityBin, PortfolioPosition } from "@/components/octora/types";
import { Button } from "@/components/ui/button";
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
import { markLocalPositionClosed, removeLocalPosition } from "@/lib/localPositions";
import { useSolana } from "@/providers/SolanaProvider";
import { PrivateClaimModal } from "@/components/octora/lp/PrivateClaimModal";
import { PrivateExitModal } from "@/components/octora/lp/PrivateExitModal";
import { PrivateRebalanceModal } from "@/components/octora/lp/PrivateRebalanceModal";
import { StealthAddressDisplay } from "@/components/octora/lp/StealthAddressDisplay";

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

      {/* Action drawer */}
      <Reveal delay={240}>
        <ActionDrawer position={position} bins={bins} initialLower={lower} initialUpper={upper} center={center} />
      </Reveal>
    </div>
  );
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

function WithdrawPanel({ position }: { position: PortfolioPosition }) {
  const { wallet } = useSolana();
  const [modalOpen, setModalOpen] = useState(false);

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

