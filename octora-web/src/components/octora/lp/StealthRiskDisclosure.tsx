import { AlertTriangle } from "lucide-react";

interface Props {
  acknowledged?: boolean;
  onAcknowledgedChange?: (checked: boolean) => void;
  compact?: boolean;
}

export function StealthRiskDisclosure({
  acknowledged,
  onAcknowledgedChange,
  compact = false,
}: Props) {
  const ackId = "stealth-risk-ack";
  return (
    <div
      role="alert"
      aria-live="polite"
      className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
        <div className="space-y-2">
          <p className="font-medium text-amber-100">
            Lose origin wallet = lose Position funds.
          </p>
          <p className="text-amber-100/85">
            Your Position's stealth wallet can only be recovered by the origin wallet
            that signs the derivation message. There is no backend escrow or passphrase
            fallback, so if that origin wallet is gone, the SOL in this Position is
            unrecoverable.
          </p>
          <p className="text-amber-100/85">
            This is what preserves privacy: the backend cannot recover or link your
            Position, and observers cannot connect the origin wallet to the stealth
            LP owner unless you reveal it.
          </p>
          {onAcknowledgedChange && (
            <label
              htmlFor={ackId}
              className={[
                "flex items-start gap-2 text-xs font-medium text-amber-50",
                compact ? "pt-0" : "pt-1",
              ].join(" ")}
            >
              <input
                id={ackId}
                type="checkbox"
                checked={acknowledged ?? false}
                onChange={(e) => onAcknowledgedChange(e.target.checked)}
                className="mt-1"
              />
              <span>I understand that losing my origin wallet means losing these Position funds.</span>
            </label>
          )}
        </div>
      </div>
    </div>
  );
}
