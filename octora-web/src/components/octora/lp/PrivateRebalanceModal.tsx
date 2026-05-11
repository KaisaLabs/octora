import { useEffect, useState } from "react";
import { ArrowRight, Check, ExternalLink, Loader2, Repeat, ShieldCheck, X } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSolana } from "@/providers/SolanaProvider";
import {
  preflightEstimateRebalance,
  runPrivateRebalance,
  type PrivateRebalanceResult,
  type RebalancePreflightEstimate,
  type RebalanceStepEvent,
  type RebalanceStepKey,
} from "@/lib/privateRebalance";
import { markLocalPositionRebalanced } from "@/lib/localPositions";
import type { DistributionShape } from "@/components/octora/types";
import { captureException } from "@/lib/observability";

/** Subset of position fields the rebalance modal needs. Same shape as
 *  PrivateExitPosition + the old range so the preview can render a diff. */
export interface PrivateRebalancePosition {
  positionId: string;
  poolAddress: string;
  stealthPubkey: string;
  /** Current on-chain range; rendered as the "before" side of the diff. */
  lowerBinId: number;
  upperBinId: number;
  shape: DistributionShape;
  depositedUsd: number;
  derivationVersion?: "v1" | "v2";
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  position: PrivateRebalancePosition;
  newLowerBinId: number;
  newUpperBinId: number;
  newShape: DistributionShape;
}

type Phase = "preview" | "running" | "success" | "error";

const STEP_LABELS: Record<RebalanceStepKey, string> = {
  derive: "Authorize private session",
  "position-state": "Read current range",
  close: "Close old range",
  swap: "Consolidate to SOL",
  "use-pool": "Load new range",
  "init-position": "Open new range",
  "add-liquidity": "Deploy liquidity",
  done: "Done",
};

const STEP_ORDER: RebalanceStepKey[] = [
  "derive",
  "position-state",
  "close",
  "swap",
  "use-pool",
  "init-position",
  "add-liquidity",
];

export function PrivateRebalanceModal({
  open,
  onOpenChange,
  position,
  newLowerBinId,
  newUpperBinId,
  newShape,
}: Props) {
  const { wallet } = useSolana();

  const [phase, setPhase] = useState<Phase>("preview");
  const initialStepStatuses = (): Record<RebalanceStepKey, "pending" | "active" | "ok" | "error"> => ({
    derive: "pending",
    "position-state": "pending",
    close: "pending",
    swap: "pending",
    "use-pool": "pending",
    "init-position": "pending",
    "add-liquidity": "pending",
    done: "pending",
  });
  const [stepStatuses, setStepStatuses] = useState(initialStepStatuses);
  const [activeMessage, setActiveMessage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [result, setResult] = useState<PrivateRebalanceResult | null>(null);
  const [preflight, setPreflight] = useState<
    | { status: "loading" }
    | { status: "ok"; estimate: RebalancePreflightEstimate }
    | { status: "error"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    if (!open) return;
    setPhase("preview");
    setStepStatuses(initialStepStatuses());
    setActiveMessage("");
    setErrorMessage("");
    setResult(null);
    setPreflight({ status: "loading" });

    let cancelled = false;
    preflightEstimateRebalance({
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

  const handleStep = (event: RebalanceStepEvent) => {
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
      const res = await runPrivateRebalance(
        {
          mainWalletAddress: wallet.address,
          poolAddress: position.poolAddress,
          positionId:
            position.derivationVersion === "v1" ? undefined : position.positionId,
          newLowerBinId,
          newUpperBinId,
          newShape,
        },
        handleStep,
      );
      setResult(res);
      setPhase("success");
      try {
        markLocalPositionRebalanced(wallet.address, position.positionId, {
          lowerBinId: newLowerBinId,
          upperBinId: newUpperBinId,
          shape: newShape,
          positionPubkey: res.newPositionPubkey,
          fundSignature: res.addLiquiditySignature,
        });
      } catch {
        // Non-fatal — the on-chain rebalance already succeeded; the next
        // portfolio refresh will pick up the new state from chain.
      }
    } catch (err) {
      captureException(err, { flow: "privateRebalance", pool: position.poolAddress });
      setPhase("error");
    }
  };

  const close = () => {
    if (phase === "running") return;
    onOpenChange(false);
  };

  const previewReady = wallet.connected && preflight.status === "ok";

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md border-border bg-surface-elevated p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border/60 px-6 py-4">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <Repeat className="h-4 w-4 text-primary" />
            Rebalance privately
          </DialogTitle>
        </DialogHeader>

        <div className="px-6 py-5">
          {phase === "preview" && (
            <PreviewBody
              position={position}
              newLowerBinId={newLowerBinId}
              newUpperBinId={newUpperBinId}
              newShape={newShape}
              preflight={preflight}
            />
          )}
          {(phase === "running" || phase === "error") && (
            <RunningBody
              steps={stepStatuses}
              activeMessage={activeMessage}
              errorMessage={errorMessage}
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
                Rebalance privately
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </>
          )}
          {phase === "running" && (
            <span className="text-xs text-muted-foreground">
              Don't close this window — the rebalance takes a minute or two.
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
  | { status: "ok"; estimate: RebalancePreflightEstimate }
  | { status: "error"; message: string };

function PreviewBody({
  position,
  newLowerBinId,
  newUpperBinId,
  newShape,
  preflight,
}: {
  position: PrivateRebalancePosition;
  newLowerBinId: number;
  newUpperBinId: number;
  newShape: DistributionShape;
  preflight: PreflightState;
}) {
  const alreadyClosed =
    preflight.status === "ok" && preflight.estimate.positionAlreadyClosed;

  return (
    <div className="space-y-5 text-sm">
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-xs leading-5 text-foreground/80">
        <div className="mb-1.5 flex items-center gap-1.5 font-medium text-primary">
          <ShieldCheck className="h-3.5 w-3.5" />
          Same-stealth rebalance — no mixer hop
        </div>
        {alreadyClosed ? (
          <>
            A previous attempt already closed the old range on-chain. This run
            will pick up the SOL sitting at your stealth wallet and redeploy it
            into the new range under the same stealth identity.
          </>
        ) : (
          <>
            Close the old range, consolidate any residue back to SOL, and
            redeploy into the new range — all signed by the same stealth
            keypair so the position never appears uncovered to observers. The
            mixer doesn't run; the link between your main wallet and the
            stealth was already broken at deposit time.
          </>
        )}
      </div>

      <dl className="space-y-2.5 rounded-xl border border-border bg-card/60 p-4">
        <Row label="Pool" value={`${position.poolAddress.slice(0, 6)}…${position.poolAddress.slice(-4)}`} />
        <Row
          label="Range"
          value={`${position.lowerBinId}…${position.upperBinId} → ${newLowerBinId}…${newUpperBinId}`}
        />
        <Row label="Shape" value={`${position.shape} → ${newShape}`} />
        <Row
          label="Stealth wallet"
          value={`${position.stealthPubkey.slice(0, 6)}…${position.stealthPubkey.slice(-4)}`}
        />
        {preflight.status === "loading" && (
          <Row label="Estimated redeploy" value="Estimating…" />
        )}
        {preflight.status === "ok" && (
          <Row
            label="Estimated redeploy"
            value={`≈ ${formatSol(preflight.estimate.estimatedRedeployableLamports)}`}
          />
        )}
        {preflight.status === "error" && (
          <Row label="Estimated redeploy" value="Estimate unavailable" />
        )}
      </dl>

      {preflight.status === "error" && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4 text-xs leading-5 text-rose-200">
          Couldn't estimate the redeployable amount: {preflight.message}. You
          can still proceed; the on-chain close + add will report the real
          balance.
        </div>
      )}
    </div>
  );
}

function RunningBody({
  steps,
  activeMessage,
  errorMessage,
}: {
  steps: Record<RebalanceStepKey, "pending" | "active" | "ok" | "error">;
  activeMessage: string;
  errorMessage: string;
}) {
  return (
    <div className="space-y-4 text-sm">
      <ul className="space-y-1.5">
        {STEP_ORDER.map((key) => {
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

function SuccessBody({ result }: { result: PrivateRebalanceResult }) {
  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-xs leading-5 text-emerald-200">
        <div className="mb-1.5 flex items-center gap-1.5 font-medium text-emerald-300">
          <Check className="h-3.5 w-3.5" />
          Rebalance complete
        </div>
        {formatSol(result.fundedLamports)} redeployed into the new range under
        the same stealth wallet. No on-chain link to your main wallet was
        created or revealed.
      </div>

      <dl className="space-y-2.5 rounded-xl border border-border bg-card/60 p-4">
        <Row label="Deployed" value={formatSol(result.fundedLamports)} />
        <Row
          label="New position"
          value={`${result.newPositionPubkey.slice(0, 6)}…${result.newPositionPubkey.slice(-4)}`}
        />
      </dl>

      <div className="space-y-1.5 text-xs">
        <ExplorerLink label="Close" sig={result.closeSignature} />
        {result.swapSignature && (
          <ExplorerLink label="Swap" sig={result.swapSignature} />
        )}
        {result.initSignature && (
          <ExplorerLink label="Init new range" sig={result.initSignature} />
        )}
        <ExplorerLink label="Add liquidity" sig={result.addLiquiditySignature} />
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
