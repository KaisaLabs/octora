/**
 * UserSignedCloseRecoveryDisclosure — surfaces the privacy trade-off
 * of the close/03 user-signed close-recovery path before the user
 * signs. Mirrors `UserSignedRecoveryDisclosure` (dust/04) but the copy
 * is specific to the Flow 3 close-flow context (CLOSE_FAILED /
 * SWAP_FAILED / REMIX_FAILED), and gives the user two distinct
 * recovery paths to acknowledge:
 *   - `complete-close` — sign the remaining leg(s) themselves. Same
 *     privacy outcome as the orchestrator-driven close would have had
 *     (re-mix lands a fresh Commitment) PLUS the origin-wallet link
 *     from being the signer.
 *   - `bail-to-withdrawn` — sign a direct withdraw. No re-mix; the
 *     funds end up at the origin wallet (or a destination they
 *     control), and the origin-wallet → destination link is fully
 *     visible on-chain.
 *
 * The disclosure is up-front (not post-hoc) because the user is the
 * one initiating the action — same pattern as the dust/04 dialog.
 */
import { AlertTriangle } from "lucide-react";

import type { CloseRecoveryAction } from "@/lib/userSignedCloseRecovery";

interface Props {
  acknowledged?: boolean;
  onAcknowledgedChange?: (checked: boolean) => void;
  /** Which recovery path the user is about to sign. */
  recoveryAction: CloseRecoveryAction;
  /** Address the funds will be sent to (defaults to origin wallet). */
  recipient?: string;
}

export function UserSignedCloseRecoveryDisclosure({
  acknowledged,
  onAcknowledgedChange,
  recoveryAction,
  recipient,
}: Props) {
  const ackId = "user-signed-close-recovery-ack";
  const recipientShort = recipient ? shorten(recipient) : "your origin wallet";

  const headline =
    recoveryAction === "complete-close"
      ? "User-signed close-recovery breaks unlinkability for the remaining leg(s)."
      : "Bailing to a direct withdraw breaks unlinkability for this Position.";

  const body =
    recoveryAction === "complete-close"
      ? `You are about to sign the remaining close-flow transaction(s) with your origin wallet. Once they land, an on-chain observer can link your origin wallet to the destination — the fresh Commitment goes into the Mixer Pool, but the origin-wallet signature on the way there is still visible. The privacy this Position preserved up to the close stops here.`
      : `You are about to sign a direct withdraw with your origin wallet and send the recovered funds to ${recipientShort}. After this transaction lands, an on-chain observer can link your origin wallet to that destination. The re-mix step is skipped entirely — no fresh Commitment is created; the close is rolled back into a direct withdraw.`;

  return (
    <div
      role="alert"
      aria-live="polite"
      className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
        <div className="space-y-2">
          <p className="font-medium text-amber-100">{headline}</p>
          <p className="text-amber-100/85">{body}</p>
          <p className="text-amber-100/85">
            This is the worst-case-but-always-available SAFE path for the
            Private Position Close flow. It works even if Octora's relayer
            is offline — recovery never depends on the backend. Pick this
            path only if you cannot wait for the relayer to retry.
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
                I understand recovering funds myself means the origin wallet
                will be visibly linked to the destination on-chain.
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
