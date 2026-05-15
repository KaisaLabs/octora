/**
 * UserSignedRecoveryDisclosure — surfaces the privacy trade-off of the
 * dust/04 user-signed Recover Funds path before the user signs.
 *
 * Same pattern as the existing `StealthRiskDisclosure` (which warns
 * about losing the origin wallet) and mirrors the post-hoc disclosure
 * banner used for Mode Fallback (ADR-0001). The difference: this
 * disclosure is *up-front* because the user is the one initiating the
 * action — the trade-off is part of the choice, not a consequence to
 * be surfaced after the fact.
 *
 * What the user is acknowledging:
 *   - The recovery transaction is signed by their **origin wallet**,
 *     not the stealth wallet (which is the privacy-preserving path).
 *   - The origin wallet's address ends up linked on-chain to the
 *     withdraw destination, which an observer can follow.
 *   - This is the worst-case-but-always-available path: it never
 *     depends on Octora's backend or relayer being online.
 */
import { AlertTriangle } from "lucide-react";

interface Props {
  acknowledged?: boolean;
  onAcknowledgedChange?: (checked: boolean) => void;
  /** Address the funds will be sent to (defaults to origin wallet). */
  recipient?: string;
}

export function UserSignedRecoveryDisclosure({
  acknowledged,
  onAcknowledgedChange,
  recipient,
}: Props) {
  const ackId = "user-signed-recovery-ack";
  const recipientShort = recipient ? shorten(recipient) : "your origin wallet";
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
            User-signed recovery breaks unlinkability for this Position.
          </p>
          <p className="text-amber-100/85">
            You are about to sign the mixer withdraw with your origin wallet
            and send the recovered funds to <span className="font-mono">{recipientShort}</span>.
            After this transaction lands, an on-chain observer can link your
            origin wallet to that destination. The privacy this Position
            preserved up to now is intentionally given up in exchange for
            the guarantee that recovery never depends on Octora's backend.
          </p>
          <p className="text-amber-100/85">
            This is the worst-case-but-always-available SAFE path. Picking
            "Retry private LP" or "Park for later" keeps the unlinkability
            intact and waits for the relayer to come back. Recovery is only
            necessary when you do not want to wait.
          </p>
          {onAcknowledgedChange && (
            <label
              htmlFor={ackId}
              className="flex items-start gap-2 pt-1 text-xs font-medium text-amber-50"
            >
              <input
                id={ackId}
                type="checkbox"
                checked={acknowledged ?? false}
                onChange={(e) => onAcknowledgedChange(e.target.checked)}
                className="mt-1"
              />
              <span>
                I understand my origin wallet will be linkable to the
                recovery destination on-chain.
              </span>
            </label>
          )}
        </div>
      </div>
    </div>
  );
}

function shorten(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}
