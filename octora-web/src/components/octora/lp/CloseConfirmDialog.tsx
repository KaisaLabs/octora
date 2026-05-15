/**
 * close/02 — Pre-flight close confirmation modal.
 *
 * Renders between the Close button click (close/01's WithdrawPanel button)
 * and the actual `POST /positions/:id/close` request. Shows the expected
 * post-close balances, the swap preview (when there's a non-SOL residual
 * above the dust threshold), and the slippage selector that decides the
 * swap's `min_amount_out`.
 *
 * Responsibilities:
 *   1. Render the close-quote line items the backend computed.
 *   2. Let the user pick a slippage tolerance (presets + Custom input).
 *   3. Recompute the *displayed* min_amount_out client-side as slippage
 *      changes — no extra network call (per the ticket's UI contract).
 *   4. Gate "Confirm close" until the user has either kept the default or
 *      explicitly confirmed/set a custom value.
 *   5. Hide the slippage selector entirely when the quote has no `swap`
 *      field (orchestrator will skip the swap leg).
 *
 * Pure props in, callback out — the parent (`PositionDetailPage`) owns
 * the fetch + the POST, so this component stays testable in isolation
 * without a network mock or a router.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Shape returned by `GET /positions/:positionId/close-quote`. Kept inline
 * (matches the close/02 service-side `CloseQuoteResponse`) so the
 * frontend doesn't take a cross-package type import.
 */
export type CloseQuoteResponse =
  | { closeable: false; reason: string; details?: { mint?: string; extension?: string } }
  | {
      closeable: true;
      estimate: {
        solLamports: string;
        otherSideLamports: string;
        otherSideSymbol: string | null;
        accruedFeeSolLamports: string;
        accruedFeeOtherLamports: string;
      };
      swap?: {
        inLamports: string;
        expectedOutLamports: string;
        feeLamports: string;
        priceImpact: string;
      };
      denomination: string;
      dustLamports: string;
    };

const SLIPPAGE_PRESETS_BPS = [10, 50, 100] as const;
const DEFAULT_SLIPPAGE_BPS = 50;
const MIN_SLIPPAGE_BPS = 10;
const MAX_SLIPPAGE_BPS = 500;

export interface CloseConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Quote payload from `GET /close-quote`. Must be `closeable: true`. */
  quote: Extract<CloseQuoteResponse, { closeable: true }>;
  /**
   * Fires when the user confirms. The parent posts to `/close` with
   * `slippageBps` + the `expectedSwapOutLamports` echo from the quote.
   * `expectedSwapOutLamports` is null when the quote has no swap field.
   */
  onConfirm: (input: {
    slippageBps: number;
    expectedSwapOutLamports: string | null;
  }) => void | Promise<void>;
  /** Pending state from the parent (disables Confirm while POST is in flight). */
  pending?: boolean;
}

export function CloseConfirmDialog({
  open,
  onOpenChange,
  quote,
  onConfirm,
  pending = false,
}: CloseConfirmDialogProps) {
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  const [customInput, setCustomInput] = useState<string>("");
  const [usingCustom, setUsingCustom] = useState(false);
  /**
   * "Confirmed" gate from the ticket: Confirm-close is enabled only after
   * the user actively keeps the default OR sets a valid custom value.
   * Mirrors the pattern in `UserSignedRecoveryDialog`'s acknowledgement
   * checkbox — privacy-load-bearing UI should never one-click through.
   */
  const [confirmedSlippage, setConfirmedSlippage] = useState(false);

  // Reset state every time the dialog opens so a previous session's
  // selection doesn't carry over (the quote may have changed).
  useEffect(() => {
    if (open) {
      setSlippageBps(DEFAULT_SLIPPAGE_BPS);
      setCustomInput("");
      setUsingCustom(false);
      setConfirmedSlippage(false);
    }
  }, [open]);

  const hasSwap = quote.swap !== undefined;
  const swap = quote.swap;

  /**
   * Client-side min_amount_out preview. Pure computation off the
   * captured `expectedOutLamports`; no network call (per ticket).
   * Uses BigInt so we don't lose precision on lamports near the 2^53
   * ceiling.
   */
  const minOutLamports = useMemo<bigint | null>(() => {
    if (!swap) return null;
    try {
      const expected = BigInt(swap.expectedOutLamports);
      const bps = BigInt(slippageBps);
      // min = expected * (10_000 - bps) / 10_000
      return (expected * (10_000n - bps)) / 10_000n;
    } catch {
      return null;
    }
  }, [swap, slippageBps]);

  const customParsed = parseInt(customInput, 10);
  const customValid =
    customInput !== "" &&
    Number.isFinite(customParsed) &&
    customParsed >= MIN_SLIPPAGE_BPS &&
    customParsed <= MAX_SLIPPAGE_BPS;

  const handlePreset = (bps: number) => {
    setUsingCustom(false);
    setCustomInput("");
    setSlippageBps(bps);
    setConfirmedSlippage(true);
  };

  const handleCustomChange = (raw: string) => {
    setUsingCustom(true);
    setCustomInput(raw);
    const parsed = parseInt(raw, 10);
    if (
      Number.isFinite(parsed) &&
      parsed >= MIN_SLIPPAGE_BPS &&
      parsed <= MAX_SLIPPAGE_BPS
    ) {
      setSlippageBps(parsed);
      setConfirmedSlippage(true);
    } else {
      setConfirmedSlippage(false);
    }
  };

  // No-swap case: skip slippage step entirely. Confirm is enabled as
  // soon as the dialog opens.
  const confirmDisabled =
    pending || (hasSwap && !confirmedSlippage) || (usingCustom && !customValid);

  const handleConfirm = async () => {
    await onConfirm({
      slippageBps: hasSwap ? slippageBps : DEFAULT_SLIPPAGE_BPS,
      expectedSwapOutLamports: swap?.expectedOutLamports ?? null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="close-confirm-dialog">
        <DialogHeader>
          <DialogTitle>Confirm close</DialogTitle>
          <DialogDescription>
            Review the expected post-close balances. Once you confirm, the
            relayer drives the three-tx Private Position Close: dlmm_withdraw_close
            {hasSwap ? " → dlmm_swap" : ""} → mixer.deposit.
          </DialogDescription>
        </DialogHeader>

        <section
          className="space-y-3 rounded-2xl border border-border bg-card/40 p-4"
          data-testid="close-confirm-estimate"
        >
          <Line
            label="Stealth SOL after close"
            value={`${formatLamports(quote.estimate.solLamports)} SOL`}
          />
          {quote.estimate.otherSideLamports !== "0" && (
            <Line
              label={`Stealth ${quote.estimate.otherSideSymbol ?? "other"} after close`}
              value={`${quote.estimate.otherSideLamports} (raw)`}
            />
          )}
          {hasSwap && swap && (
            <>
              <Line
                label={`Swap ${quote.estimate.otherSideSymbol ?? "other"} → SOL`}
                value={`${swap.inLamports} → ${formatLamports(swap.expectedOutLamports)} SOL`}
              />
              <Line
                label="Meteora fee"
                value={`${formatLamports(swap.feeLamports)} SOL`}
              />
              <Line
                label="Price impact"
                value={formatPercent(swap.priceImpact)}
              />
            </>
          )}
          <Line
            label="Re-mix denomination"
            value={
              quote.denomination === "0"
                ? "Unknown (resolved on close)"
                : `${formatLamports(quote.denomination)} SOL`
            }
          />
          <Line
            label="Sub-denom dust at stealth"
            value={`${formatLamports(quote.dustLamports)} SOL`}
            muted
          />
        </section>

        {hasSwap && swap && (
          <section
            className="space-y-3 rounded-2xl border border-border bg-card/40 p-4"
            data-testid="close-confirm-slippage"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Slippage tolerance
              </p>
              <p className="font-mono text-xs text-foreground">
                Min received:{" "}
                <span data-testid="close-confirm-min-out">
                  {minOutLamports !== null
                    ? `${formatLamports(minOutLamports.toString())} SOL`
                    : "—"}
                </span>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {SLIPPAGE_PRESETS_BPS.map((bps) => {
                const selected = !usingCustom && slippageBps === bps;
                return (
                  <button
                    key={bps}
                    type="button"
                    onClick={() => handlePreset(bps)}
                    data-testid={`slippage-preset-${bps}`}
                    data-selected={selected ? "true" : "false"}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      selected
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-card text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {(bps / 100).toFixed(bps === 10 ? 1 : bps === 50 ? 1 : 0)}%
                  </button>
                );
              })}
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Custom (bps)</span>
                <input
                  type="number"
                  min={MIN_SLIPPAGE_BPS}
                  max={MAX_SLIPPAGE_BPS}
                  value={customInput}
                  onChange={(e) => handleCustomChange(e.target.value)}
                  data-testid="slippage-custom"
                  className="w-20 rounded-md border border-border bg-background px-2 py-1 font-mono text-foreground"
                  placeholder="—"
                />
              </label>
            </div>
            {usingCustom && !customValid && customInput !== "" && (
              <p
                className="text-[11px] text-destructive"
                data-testid="close-confirm-slippage-error"
              >
                Slippage must be {MIN_SLIPPAGE_BPS}–{MAX_SLIPPAGE_BPS} bps
                (0.1%–5%).
              </p>
            )}
            {!confirmedSlippage && (
              <p className="text-[11px] text-muted-foreground">
                Pick a preset or enter a custom value to enable confirm.
              </p>
            )}
          </section>
        )}

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
            onClick={handleConfirm}
            disabled={confirmDisabled}
            data-testid="close-confirm-submit"
          >
            {pending ? <Loader2 className="animate-spin" /> : null}
            Confirm close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Line({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={`font-mono text-sm tabular-nums ${
          muted ? "text-muted-foreground" : "text-foreground"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function formatLamports(raw: string): string {
  try {
    const n = BigInt(raw);
    if (n === 0n) return "0";
    const int = n / 1_000_000_000n;
    const frac = n % 1_000_000_000n;
    if (frac === 0n) return int.toString();
    const fracStr = frac.toString().padStart(9, "0").slice(0, 6).replace(/0+$/, "");
    return fracStr ? `${int.toString()}.${fracStr}` : int.toString();
  } catch {
    return raw;
  }
}

function formatPercent(decimalString: string): string {
  const n = parseFloat(decimalString);
  if (!Number.isFinite(n)) return decimalString;
  return `${(n * 100).toFixed(2)}%`;
}
