/**
 * Earned fees card — Mid-position fee claim (close/05).
 *
 * Sits on the Position detail page above the action drawer and is
 * only rendered when the Position state is `active`. Differs from
 * `ClaimSummary` in that the claim does NOT close the Position; fees
 * land in the Stealth Wallet's free balance and the user picks
 * Re-mix or Leave-it as a follow-up.
 *
 * Region-disjointness with ticket 01 (Close button): this card is a
 * standalone section above `ActionDrawer`. The Close button lives
 * inside `ActionDrawer`. Future cross-ticket integrations stay clean
 * as long as both regions remain self-contained.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Coins, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { PortfolioPosition } from "@/components/octora/types";
import {
  claimMidPositionFees,
  remixClaimedFees,
  type MidPositionClaimReceipt,
} from "@/lib/api";
import { useSolana } from "@/providers/SolanaProvider";

/**
 * Display threshold for surfacing the Claim button. Mirrors the
 * backend constant `MID_POSITION_FEE_CLAIM_DISPLAY_THRESHOLD_LAMPORTS`
 * (0.01 SOL). The Position card's `feesUsd` is the truthful source —
 * we don't have a separate accrued-fee lamport read on the client.
 */
export const EARNED_FEES_DISPLAY_THRESHOLD_USD = 0.01;
export const EARNED_FEES_DISPLAY_THRESHOLD_LAMPORTS = 10_000_000n; // 0.01 SOL

/**
 * Default Mixer Pool denomination for the one-click Re-mix offer.
 * Per Day-1 multi-denom backend the pool registry exposes 0.1 / 1 /
 * 10 SOL; we default to the smallest so the offer activates as soon
 * as the SOL portion clears it. The PositionDetail page wiring can
 * thread the original Position's denom in once that's persisted.
 */
const DEFAULT_REMIX_DENOM_LAMPORTS = 100_000_000n; // 0.1 SOL

const STEALTH_DISCLOSURE =
  "Fees will sit in your Stealth Wallet until you re-mix or full-close.";

interface Props {
  position: PortfolioPosition;
  /**
   * Position state from the backend Position aggregate. The card
   * renders only when this is `active` (or equivalent display
   * strings — see `isActivePosition`). The PositionDetail page
   * threads this in from `position.status`.
   */
  positionState?: string;
  /**
   * Mixer Pool denomination (lamports) the original Position used.
   * Defaults to the smallest configured denom when the caller
   * doesn't have a precise value yet.
   */
  remixDenomLamports?: bigint;
}

function isActivePosition(state: string | undefined): boolean {
  if (!state) return false;
  const norm = state.trim().toLowerCase();
  return norm === "active" || norm === "position active";
}

export function EarnedFeesCard({
  position,
  positionState,
  remixDenomLamports = DEFAULT_REMIX_DENOM_LAMPORTS,
}: Props) {
  // Gate on `active` — claim is only valid on a live Position. The
  // ClaimSummary card (above) drives the legacy claim-and-close flow;
  // this card is the no-close path.
  if (!isActivePosition(positionState ?? position.status)) {
    return null;
  }

  const { wallet } = useSolana();
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<MidPositionClaimReceipt | null>(null);
  const [remixed, setRemixed] = useState(false);
  const [remixPending, setRemixPending] = useState(false);
  const [leftAlone, setLeftAlone] = useState(false);

  const feesUsd = position.feesUsd ?? 0;
  const aboveThreshold = feesUsd >= EARNED_FEES_DISPLAY_THRESHOLD_USD;
  // The display-threshold check is intentionally permissive: when the USD
  // price feed is missing (devnet pools) but `hasClaimableFees` is true,
  // we still allow the click — the lamport-level guard lives on-chain.
  const fallbackToHasFees = position.hasClaimableFees === true && feesUsd === 0;
  const canClaim =
    wallet.connected && (aboveThreshold || fallbackToHasFees) && !pending && !receipt;

  const handleClaim = async () => {
    if (!wallet.address) {
      toast.error("Connect your wallet to claim.");
      return;
    }
    setPending(true);
    const t = toast.loading("Claiming fees to Stealth Wallet…");
    try {
      const r = await claimMidPositionFees(position.id, {
        walletAddress: wallet.address,
      });
      setReceipt(r);
      toast.success("Fees claimed", { id: t });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { id: t });
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      data-testid="earned-fees-card"
      className="panel-shell rounded-2xl p-5 sm:p-6"
    >
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
            Earned fees
          </p>
          <p className="mt-1 font-display text-lg font-semibold tracking-tight text-foreground">
            Claim mid-position without closing
          </p>
        </div>
        <span className="rounded-full border border-border bg-secondary/60 px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Position stays active
        </span>
      </header>

      {receipt ? (
        <PostClaimPanel
          position={position}
          receipt={receipt}
          remixDenomLamports={remixDenomLamports}
          remixed={remixed}
          remixPending={remixPending}
          leftAlone={leftAlone}
          onRemix={async () => {
            if (!wallet.address) {
              toast.error("Connect your wallet to re-mix.");
              return;
            }
            setRemixPending(true);
            const t = toast.loading("Re-mixing claimed SOL…");
            try {
              await remixClaimedFees(
                position.id,
                { denomLamports: remixDenomLamports.toString() },
                { walletAddress: wallet.address },
              );
              setRemixed(true);
              toast.success("Re-mixed into Mixer Pool", { id: t });
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err), { id: t });
            } finally {
              setRemixPending(false);
            }
          }}
          onLeaveIt={() => setLeftAlone(true)}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-center">
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
              Accrued fees (preview)
            </p>
            <p
              className={`mt-1 font-mono text-xl font-semibold tabular-nums ${
                aboveThreshold ? "text-primary" : "text-foreground/70"
              }`}
              data-testid="earned-fees-accrued"
            >
              {position.feesEarned}
            </p>
            {!aboveThreshold && !fallbackToHasFees && (
              <p className="mt-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                Below claim threshold ({EARNED_FEES_DISPLAY_THRESHOLD_USD.toFixed(2)} USD)
              </p>
            )}
          </div>

          <Button
            variant="hero"
            size="lg"
            disabled={!canClaim}
            onClick={handleClaim}
            className="w-full justify-center rounded-xl lg:w-auto"
            data-testid="earned-fees-claim-button"
          >
            {pending ? <Loader2 className="animate-spin" /> : <Coins className="h-4 w-4" />}
            Claim fees (no close)
            {!pending && <ArrowRight className="h-4 w-4" />}
          </Button>
        </div>
      )}

      <p className="mt-4 text-[11px] leading-5 text-muted-foreground">
        Fees claim into the Stealth Wallet's free balance. Position state stays
        <span className="font-mono"> active</span> — re-mix the SOL portion or leave
        it sitting; either way the Position keeps earning.
      </p>
    </section>
  );
}

function PostClaimPanel({
  position,
  receipt,
  remixDenomLamports,
  remixed,
  remixPending,
  leftAlone,
  onRemix,
  onLeaveIt,
}: {
  position: PortfolioPosition;
  receipt: MidPositionClaimReceipt;
  remixDenomLamports: bigint;
  remixed: boolean;
  remixPending: boolean;
  leftAlone: boolean;
  onRemix: () => void;
  onLeaveIt: () => void;
}) {
  const solLamports = useMemo(() => BigInt(receipt.claimedSolLamports), [receipt]);
  const otherLamports = useMemo(() => BigInt(receipt.claimedOtherLamports), [receipt]);
  const solDisplay = formatLamportsToSol(solLamports);

  const remixSolDisplay = formatLamportsToSol(remixDenomLamports);

  // Re-mix offer activates only when the SOL portion is ≥ one Mixer
  // Pool denomination. Sub-denom SOL stays in the stealth (accepted
  // protocol-level dust per ADR-0003).
  const remixOfferActive = solLamports >= remixDenomLamports;

  // Token-2022 / TransferHook gating per ticket 04. We don't have the
  // assertExecutorSupportsMint helper yet — surface a TODO tooltip
  // when there's a non-SOL residual so the post-claim panel is honest
  // about what re-mix supports today.
  // TODO(close/04): use assertExecutorSupportsMint() once landed to
  // detect TransferHook'd other-side mints and disable re-mix only
  // for unsupported mint extensions.
  const remixUnsupportedTooltip =
    otherLamports > 0n && receipt.claimedOtherMintSymbol
      ? `Re-mix only deposits the SOL portion. The ${receipt.claimedOtherMintSymbol} residual stays in your Stealth Wallet.`
      : undefined;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
        <p className="text-[11px] uppercase tracking-[0.22em] text-emerald-300">
          Claim landed in Stealth Wallet
        </p>
        <p className="mt-2 font-mono text-base font-semibold tabular-nums text-foreground">
          {solDisplay} SOL
          {otherLamports > 0n && receipt.claimedOtherMintSymbol && (
            <span className="text-foreground/70">
              {" + "}
              {otherLamports.toString()} {receipt.claimedOtherMintSymbol}
            </span>
          )}
        </p>
        <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
          Sig: {receipt.signature}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div
          className="rounded-xl border border-border bg-card/60 p-3"
          data-testid="earned-fees-remix-offer"
          data-active={remixOfferActive ? "true" : "false"}
        >
          <Button
            variant="hero"
            size="lg"
            disabled={!remixOfferActive || remixed || remixPending}
            onClick={onRemix}
            title={remixUnsupportedTooltip}
            className="w-full justify-center rounded-xl"
            data-testid="earned-fees-remix-button"
          >
            {remixPending ? <Loader2 className="animate-spin" /> : null}
            {remixed ? "Re-mixed" : `Re-mix ${remixSolDisplay} SOL`}
          </Button>
          <p className="mt-2 text-[10px] uppercase tracking-[0.18em] text-primary">
            One-click flow
          </p>
          <p className="text-[11px] leading-5 text-muted-foreground">
            {remixOfferActive
              ? "Deposit one denomination into the same Mixer Pool. Produces a fresh Commitment you can withdraw later."
              : `SOL portion below one Mixer denomination (${remixSolDisplay} SOL). Fees stay in stealth.`}
          </p>
          {remixUnsupportedTooltip && (
            <p className="mt-2 flex items-start gap-1 text-[11px] leading-5 text-amber-300/85">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              {remixUnsupportedTooltip}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card/60 p-3">
          <Button
            variant="ghost"
            size="lg"
            disabled={leftAlone}
            onClick={onLeaveIt}
            className="w-full justify-center rounded-xl"
            data-testid="earned-fees-leave-it-button"
          >
            {leftAlone ? "Left in stealth" : "Leave it"}
          </Button>
          <p className="mt-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            No further action
          </p>
          <p
            className="text-[11px] leading-5 text-muted-foreground"
            data-testid="earned-fees-leave-it-disclosure"
          >
            {STEALTH_DISCLOSURE}
          </p>
        </div>
      </div>

      {position.stealthPubkey && (
        <p className="font-mono text-[10px] text-muted-foreground">
          Stealth: {position.stealthPubkey}
        </p>
      )}
    </div>
  );
}

function formatLamportsToSol(lamports: bigint): string {
  const integerPart = lamports / 1_000_000_000n;
  const fractionPart = lamports % 1_000_000_000n;
  if (fractionPart === 0n) return integerPart.toString();
  const fractionStr = fractionPart
    .toString()
    .padStart(9, "0")
    .slice(0, 6)
    .replace(/0+$/, "");
  return fractionStr ? `${integerPart.toString()}.${fractionStr}` : integerPart.toString();
}
