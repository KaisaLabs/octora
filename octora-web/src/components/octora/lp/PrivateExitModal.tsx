import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, Check, ExternalLink, Loader2, ShieldCheck, X } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSolana } from "@/providers/SolanaProvider";
import {
  preflightEstimateExit,
  runPrivateExit,
  type ExitPreflightEstimate,
  type ExitStepEvent,
  type ExitStepKey,
  type PrivateExitResult,
} from "@/lib/privateExit";
import { markLocalPositionClosed } from "@/lib/localPositions";
import { captureException } from "@/lib/observability";

/** Minimal shape the modal needs — same fields are present on both
 *  StoredPosition (local index) and PortfolioPosition (page-level model). */
export interface PrivateExitPosition {
  /** localPositions positionId — used for marking closed AND (when
   *  `derivationVersion` is v2) keying the stealth derivation. */
  positionId: string;
  poolAddress: string;
  stealthPubkey: string;
  lowerBinId: number;
  upperBinId: number;
  depositedUsd: number;
  /** Stealth-derivation version. Missing = v1 (per-pool) for back-compat. */
  derivationVersion?: "v1" | "v2";
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  position: PrivateExitPosition;
}

type Phase = "preview" | "running" | "success" | "error";

const STEP_LABELS: Record<ExitStepKey, string> = {
  derive: "Authorize private session",
  "relayer-info": "Fetch mixer config",
  "position-state": "Read position",
  close: "Close LP position",
  swap: "Swap non-SOL → SOL",
  "pick-denomination": "Select mixer pool",
  "dust-sweep": "Sweep dust to main wallet",
  "mixer-deposit": "Deposit into mixer",
  "confirm-deposit": "Record deposit",
  "build-tree": "Reconstruct Merkle tree",
  prove: "Generate ZK proof",
  "relayer-withdraw": "Relayer credits main wallet",
  done: "Done",
};

const STEP_ORDER_MIXED: ExitStepKey[] = [
  "derive",
  "relayer-info",
  "position-state",
  "close",
  "swap",
  "pick-denomination",
  "mixer-deposit",
  "confirm-deposit",
  "build-tree",
  "prove",
  "relayer-withdraw",
];

const STEP_ORDER_SWEPT: ExitStepKey[] = [
  "derive",
  "relayer-info",
  "position-state",
  "close",
  "swap",
  "pick-denomination",
  "dust-sweep",
];

export function PrivateExitModal({ open, onOpenChange, position }: Props) {
  const { wallet } = useSolana();

  const [phase, setPhase] = useState<Phase>("preview");
  const initialStepStatuses = (): Record<ExitStepKey, "pending" | "active" | "ok" | "error"> => ({
    derive: "pending",
    "relayer-info": "pending",
    "position-state": "pending",
    close: "pending",
    swap: "pending",
    "pick-denomination": "pending",
    "dust-sweep": "pending",
    "mixer-deposit": "pending",
    "confirm-deposit": "pending",
    "build-tree": "pending",
    prove: "pending",
    "relayer-withdraw": "pending",
    done: "pending",
  });
  const [stepStatuses, setStepStatuses] = useState(initialStepStatuses);
  const [activeMessage, setActiveMessage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [result, setResult] = useState<PrivateExitResult | null>(null);
  const [preflight, setPreflight] = useState<
    | { status: "loading" }
    | { status: "ok"; estimate: ExitPreflightEstimate }
    | { status: "error"; message: string }
  >({ status: "loading" });
  /** Explicit user ack of the link-revealing dust sweep. Required before the
   *  "Exit" button enables when the pre-flight predicts dust. */
  const [dustAck, setDustAck] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPhase("preview");
    setStepStatuses(initialStepStatuses());
    setActiveMessage("");
    setErrorMessage("");
    setResult(null);
    setPreflight({ status: "loading" });
    setDustAck(false);

    let cancelled = false;
    preflightEstimateExit({
      stealthPubkey: position.stealthPubkey,
      poolAddress: position.poolAddress,
    })
      .then((estimate) => {
        if (!cancelled) setPreflight({ status: "ok", estimate });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPreflight({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, position.stealthPubkey, position.poolAddress]);

  const handleStep = (event: ExitStepEvent) => {
    setStepStatuses((prev) => ({
      ...prev,
      [event.step]:
        event.status === "active" ? "active" : event.status === "ok" ? "ok" : "error",
    }));
    if (event.message) setActiveMessage(event.message);
    if (event.status === "error" && event.message) setErrorMessage(event.message);
  };

  const start = async () => {
    if (!wallet.address) return;
    setPhase("running");
    setActiveMessage("");
    setErrorMessage("");
    try {
      const res = await runPrivateExit(
        {
          mainWalletAddress: wallet.address,
          poolAddress: position.poolAddress,
          positionId:
            position.derivationVersion === "v1" ? undefined : position.positionId,
          // The user pre-acknowledged the link-revealing sweep when the
          // pre-flight predicted dust. Pass it through so the orchestrator's
          // dust fallback engages instead of throwing.
          allowDustSweep: dustAck,
        },
        handleStep,
      );
      setResult(res);
      setPhase("success");
      // Persist the closed-state locally so the portfolio drops the
      // position from "active" and surfaces the withdraw receipt.
      try {
        // For mixed mode the relayer-withdraw tx is the "funds landed" sig;
        // for the dust-sweep fallback the sweep tx is. Either way the funds
        // are now at the main wallet, so the position record is closed.
        markLocalPositionClosed(wallet.address, position.positionId, {
          signature:
            res.relayerWithdrawSignature ?? res.sweepSignature ?? undefined,
          recipient: wallet.address,
        });
      } catch {
        // Non-fatal — the on-chain close already succeeded.
      }
    } catch (err) {
      captureException(err, { flow: "privateExit", pool: position.poolAddress });
      setPhase("error");
    }
  };

  const close = () => {
    if (phase === "running") return;
    onOpenChange(false);
  };

  const willBeDust =
    preflight.status === "ok" ? preflight.estimate.willBeDust : false;
  const alreadyClosed =
    preflight.status === "ok" ? preflight.estimate.positionAlreadyClosed : false;
  const previewReady =
    wallet.connected &&
    preflight.status === "ok" &&
    (!willBeDust || dustAck);
  const exitButtonLabel = alreadyClosed
    ? willBeDust
      ? "Sweep dust non-privately"
      : "Resume private exit"
    : willBeDust
      ? "Close + sweep non-privately"
      : "Exit privately";
  // Once running, switch the step list to swept layout the moment we see
  // either pick-denomination's ok event with mode=swept, or any non-pending
  // dust-sweep status — both unambiguously mean the orchestrator chose the
  // sweep path.
  const runningMode: "mixed" | "swept" =
    stepStatuses["dust-sweep"] !== "pending" ? "swept" : "mixed";

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md border-border bg-surface-elevated p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border/60 px-6 py-4">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Close position privately
          </DialogTitle>
        </DialogHeader>

        <div className="px-6 py-5">
          {phase === "preview" && (
            <PreviewBody
              position={position}
              preflight={preflight}
              dustAck={dustAck}
              onDustAckChange={setDustAck}
            />
          )}
          {(phase === "running" || phase === "error") && (
            <RunningBody
              steps={stepStatuses}
              activeMessage={activeMessage}
              errorMessage={errorMessage}
              mode={runningMode}
            />
          )}
          {phase === "success" && result && <SuccessBody result={result} />}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-border/60 bg-card/40 px-6 py-4">
          {phase === "preview" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="hero" onClick={start} disabled={!previewReady}>
                {exitButtonLabel}
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </>
          )}
          {phase === "running" && (
            <span className="text-xs text-muted-foreground">
              Don't close this window — the flow takes several minutes.
            </span>
          )}
          {phase === "error" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button variant="hero" onClick={start}>
                Try again
              </Button>
            </>
          )}
          {phase === "success" && (
            <Button variant="hero" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type PreflightState =
  | { status: "loading" }
  | { status: "ok"; estimate: ExitPreflightEstimate }
  | { status: "error"; message: string };

function PreviewBody({
  position,
  preflight,
  dustAck,
  onDustAckChange,
}: {
  position: PrivateExitPosition;
  preflight: PreflightState;
  dustAck: boolean;
  onDustAckChange: (next: boolean) => void;
}) {
  const willBeDust =
    preflight.status === "ok" && preflight.estimate.willBeDust;
  const alreadyClosed =
    preflight.status === "ok" && preflight.estimate.positionAlreadyClosed;

  return (
    <div className="space-y-5 text-sm">
      <div
        className={
          willBeDust
            ? "rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs leading-5 text-amber-100"
            : "rounded-xl border border-primary/30 bg-primary/5 p-4 text-xs leading-5 text-foreground/80"
        }
      >
        <div
          className={
            willBeDust
              ? "mb-1.5 flex items-center gap-1.5 font-medium text-amber-300"
              : "mb-1.5 flex items-center gap-1.5 font-medium text-primary"
          }
        >
          {willBeDust ? (
            <AlertTriangle className="h-3.5 w-3.5" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5" />
          )}
          {willBeDust
            ? "Recoverable amount is below the mixer minimum"
            : "Private exit (recommended)"}
        </div>
        {willBeDust ? (
          alreadyClosed ? (
            <>
              A previous exit attempt already closed the position on-chain, but
              the resulting SOL is sitting at your stealth wallet and is below
              the smallest mixer denomination. The flow will sweep it directly
              from your stealth wallet to your main wallet — that transfer is
              publicly visible on Solscan and links the two addresses on-chain.
              This is a recovery, not a fresh exit.
            </>
          ) : (
            <>
              Closing this position now would recover an amount smaller than
              the smallest mixer denomination, so the mixer round-trip can't
              run. The flow will instead transfer the funds directly from your
              stealth wallet to your main wallet — that transfer is publicly
              visible on Solscan and links the two addresses on-chain. To
              preserve privacy, keep the position open until it accumulates
              more SOL.
            </>
          )
        ) : alreadyClosed ? (
          <>
            A previous exit attempt already closed the position on-chain, but
            failed to complete the mixer round-trip. This run will skip the
            close + swap steps and route the SOL sitting at your stealth wallet
            through the mixer to your main wallet. No on-chain link between
            stealth and main.
          </>
        ) : (
          <>
            Close the LP position, swap residue back to SOL, and route the
            proceeds through the mixer so the funds reach your main wallet
            without an on-chain link back to the stealth wallet that held the
            position. Expect ~10 minutes end-to-end — the proof step alone can
            take 30–60 seconds in-browser.
          </>
        )}
      </div>

      <dl className="space-y-2.5 rounded-xl border border-border bg-card/60 p-4">
        <Row label="Pool" value={`${position.poolAddress.slice(0, 6)}…${position.poolAddress.slice(-4)}`} />
        <Row
          label="Range"
          value={`${position.lowerBinId} → ${position.upperBinId}`}
        />
        <Row label="Deposited" value={`$${position.depositedUsd.toLocaleString()}`} />
        <Row
          label="Stealth wallet"
          value={`${position.stealthPubkey.slice(0, 6)}…${position.stealthPubkey.slice(-4)}`}
        />
        {preflight.status === "loading" && (
          <Row label="Estimated recovery" value="Estimating…" />
        )}
        {preflight.status === "ok" && (
          <>
            <Row
              label="Estimated recovery"
              value={`≈ ${formatSol(preflight.estimate.estimatedRecoverableLamports)}`}
            />
            <Row
              label="Mixer minimum"
              value={formatSol(preflight.estimate.smallestDenominationLamports)}
            />
          </>
        )}
        {preflight.status === "error" && (
          <Row label="Estimated recovery" value="Estimate unavailable" />
        )}
      </dl>

      {willBeDust && (
        <label className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs leading-5 text-amber-100">
          <input
            type="checkbox"
            checked={dustAck}
            onChange={(e) => onDustAckChange(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            I understand closing now will send the recovered SOL directly from
            my stealth wallet to my main wallet. This link is publicly visible
            on Solscan and cannot be undone.
          </span>
        </label>
      )}

      {!willBeDust && preflight.status === "ok" && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs leading-5 text-amber-200">
          <span className="font-medium text-amber-300">Dust note: </span>
          Mixer pools come in fixed sizes (0.1 / 1 / 10 SOL). The largest size
          that fits your post-close balance routes through; any residue stays
          at the stealth wallet and can be private-exited later when it
          accumulates above the smallest pool size.
        </div>
      )}

      {preflight.status === "error" && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4 text-xs leading-5 text-rose-200">
          Couldn't estimate the recoverable amount: {preflight.message}. You can
          still proceed, but the dust-sweep fallback won't engage automatically
          — if the post-close balance is below the mixer minimum, the flow will
          stop and you can sweep manually from the position page.
        </div>
      )}
    </div>
  );
}

function RunningBody({
  steps,
  activeMessage,
  errorMessage,
  mode,
}: {
  steps: Record<ExitStepKey, "pending" | "active" | "ok" | "error">;
  activeMessage: string;
  errorMessage: string;
  mode: "mixed" | "swept";
}) {
  const order = mode === "swept" ? STEP_ORDER_SWEPT : STEP_ORDER_MIXED;
  return (
    <div className="space-y-4 text-sm">
      <ul className="space-y-1.5">
        {order.map((key) => {
          const status = steps[key];
          return (
            <li key={key} className="flex items-center gap-2.5 text-xs">
              <StepIcon status={status} />
              <span
                className={
                  status === "ok"
                    ? "text-foreground"
                    : status === "active"
                    ? "text-foreground font-medium"
                    : status === "error"
                    ? "text-rose-300"
                    : "text-muted-foreground"
                }
              >
                {STEP_LABELS[key]}
              </span>
            </li>
          );
        })}
      </ul>
      {activeMessage && (
        <p className="rounded-md border border-border/60 bg-card/40 px-3 py-2 text-xs text-muted-foreground">
          {activeMessage}
        </p>
      )}
      {errorMessage && (
        <p className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {errorMessage}
        </p>
      )}
    </div>
  );
}

function StepIcon({ status }: { status: "pending" | "active" | "ok" | "error" }) {
  if (status === "ok") return <Check className="h-3 w-3 text-emerald-400" />;
  if (status === "active") return <Loader2 className="h-3 w-3 animate-spin text-primary" />;
  if (status === "error") return <X className="h-3 w-3 text-rose-400" />;
  return <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />;
}

function SuccessBody({ result }: { result: PrivateExitResult }) {
  if (result.mode === "swept") {
    return (
      <div className="space-y-4 text-sm">
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs leading-5 text-amber-100">
          <div className="mb-1.5 flex items-center gap-1.5 font-medium text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            Funds delivered — non-private sweep
          </div>
          {formatSol(result.fundedLamports)} transferred directly from your
          stealth wallet to your main wallet. The transfer is publicly visible
          on Solscan and links the two addresses on-chain.
        </div>

        <dl className="space-y-2.5 rounded-xl border border-border bg-card/60 p-4">
          <Row label="Credited" value={formatSol(result.fundedLamports)} />
          <Row
            label="Residue at stealth"
            value={formatSol(result.residueLamports)}
          />
        </dl>

        <div className="space-y-1.5 text-xs">
          {result.closeSignature && (
            <ExplorerLink label="Close" sig={result.closeSignature} />
          )}
          {result.swapSignature && (
            <ExplorerLink label="Swap" sig={result.swapSignature} />
          )}
          {result.sweepSignature && (
            <ExplorerLink label="Sweep (stealth → main)" sig={result.sweepSignature} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-xs leading-5 text-emerald-200">
        <div className="mb-1.5 flex items-center gap-1.5 font-medium text-emerald-300">
          <Check className="h-3.5 w-3.5" />
          Exit complete — funds at your main wallet
        </div>
        {formatSol(result.fundedLamports)} credited via the mixer. No on-chain
        link between the stealth wallet that held the position and your main
        wallet.
      </div>

      <dl className="space-y-2.5 rounded-xl border border-border bg-card/60 p-4">
        <Row label="Credited" value={formatSol(result.fundedLamports)} />
        <Row
          label="Denomination"
          value={formatSol(result.selectedDenominationLamports ?? "0")}
        />
        <Row
          label="Residue at stealth"
          value={formatSol(result.residueLamports)}
        />
      </dl>

      <div className="space-y-1.5 text-xs">
        <ExplorerLink label="Close" sig={result.closeSignature} />
        {result.swapSignature && <ExplorerLink label="Swap" sig={result.swapSignature} />}
        {result.mixerDepositSignature && (
          <ExplorerLink label="Mixer deposit" sig={result.mixerDepositSignature} />
        )}
        {result.relayerWithdrawSignature && (
          <ExplorerLink
            label="Relayer withdraw"
            sig={result.relayerWithdrawSignature}
          />
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}

function ExplorerLink({ label, sig }: { label: string; sig: string }) {
  const url = `https://solscan.io/tx/${sig}?cluster=devnet`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-card/40 px-3 py-1.5 hover:border-border"
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1 font-mono tabular-nums text-foreground">
        {sig.slice(0, 6)}…{sig.slice(-4)}
        <ExternalLink className="h-3 w-3 opacity-60" />
      </span>
    </a>
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
