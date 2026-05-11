import { useEffect, useState } from "react";
import { ArrowRight, Check, ExternalLink, Loader2, ShieldCheck, X } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSolana } from "@/providers/SolanaProvider";
import {
  runPrivateExit,
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
  "mixer-deposit": "Deposit into mixer",
  "confirm-deposit": "Record deposit",
  "build-tree": "Reconstruct Merkle tree",
  prove: "Generate ZK proof",
  "relayer-withdraw": "Relayer credits main wallet",
  done: "Done",
};

const STEP_ORDER: ExitStepKey[] = [
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

  useEffect(() => {
    if (!open) return;
    setPhase("preview");
    setStepStatuses(initialStepStatuses());
    setActiveMessage("");
    setErrorMessage("");
    setResult(null);
  }, [open]);

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
        },
        handleStep,
      );
      setResult(res);
      setPhase("success");
      // Persist the closed-state locally so the portfolio drops the
      // position from "active" and surfaces the withdraw receipt.
      try {
        markLocalPositionClosed(wallet.address, position.positionId, {
          signature: res.relayerWithdrawSignature,
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
          {phase === "preview" && <PreviewBody position={position} />}
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
              <Button variant="hero" onClick={start} disabled={!wallet.connected}>
                Exit privately
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

function PreviewBody({ position }: { position: PrivateExitPosition }) {
  return (
    <div className="space-y-5 text-sm">
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-xs leading-5 text-foreground/80">
        <div className="mb-1.5 flex items-center gap-1.5 font-medium text-primary">
          <ShieldCheck className="h-3.5 w-3.5" />
          Private exit (recommended)
        </div>
        Close the LP position, swap residue back to SOL, and route the proceeds
        through the mixer so the funds reach your main wallet without an on-chain
        link back to the stealth wallet that held the position. Expect ~10 minutes
        end-to-end — the proof step alone can take 30–60 seconds in-browser.
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
      </dl>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs leading-5 text-amber-200">
        <span className="font-medium text-amber-300">Dust note: </span>
        Mixer pools come in fixed sizes (0.1 / 1 / 10 SOL). The largest size that
        fits your post-close balance is what routes through; any residue stays at
        the stealth wallet and can be private-exited later when it accumulates
        above the smallest pool size.
      </div>
    </div>
  );
}

function RunningBody({
  steps,
  activeMessage,
  errorMessage,
}: {
  steps: Record<ExitStepKey, "pending" | "active" | "ok" | "error">;
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

function SuccessBody({ result }: { result: PrivateExitResult }) {
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
        <Row label="Credited" value={`${formatSol(result.fundedLamports)}`} />
        <Row
          label="Denomination"
          value={`${formatSol(result.selectedDenominationLamports)}`}
        />
        <Row
          label="Residue at stealth"
          value={`${formatSol(result.residueLamports)}`}
        />
      </dl>

      <div className="space-y-1.5 text-xs">
        <ExplorerLink label="Close" sig={result.closeSignature} />
        {result.swapSignature && <ExplorerLink label="Swap" sig={result.swapSignature} />}
        <ExplorerLink label="Mixer deposit" sig={result.mixerDepositSignature} />
        <ExplorerLink label="Relayer withdraw" sig={result.relayerWithdrawSignature} />
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
