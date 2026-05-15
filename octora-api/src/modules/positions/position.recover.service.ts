/**
 * User-signed fallback recovery — the "no funds truly stuck" guarantee for
 * the Private Deposit → Position Open flow (per ADR-0004).
 *
 * Background. ADR-0004 closes the atomic user-signed `mixer.deposit +
 * DLMM add_liquidity` path (tx-size blocked). The default flow is the
 * two-phase deposit → add-liquidity state machine owned by dust/03,
 * which can stall in `LP_FAILED` or `PARKED` if the relayer-driven
 * retry never lands or the user explicitly parks the Position. Dust/04
 * is the load-bearing escape hatch for that case: the user signs a
 * `mixer.withdraw` directly to a fresh Stealth Wallet they control,
 * pays the relayer fee themselves out of the withdraw amount, and
 * broadcasts straight to RPC — never through the backend relayer.
 *
 * The state-machine transition body for `LP_FAILED | PARKED → WITHDRAWN`
 * lives on `DepositLpService.markWithdrawn` (dust/03). This service is
 * the dust/04-owned recovery-specific wrapper: it asserts the source
 * state is one of the two recover-permitted ones, records the
 * user-signed evidence (signature + destination) into the activity
 * row's detail, and delegates the transition itself to the dust/03
 * service so the state machine stays single-owner.
 *
 * Privacy. A user-signed recovery *does* link the origin wallet to the
 * withdraw destination on-chain (ADR-0002's invariant: the origin
 * wallet is the only thing that can decrypt the Stealth Seed). The
 * frontend surfaces this trade-off in a disclosure dialog before the
 * user signs — mirroring the post-hoc disclosure pattern ADR-0001 uses
 * for Mode Fallback, except this one is up-front because the user is
 * the one initiating it.
 */
import type { PositionRepository } from "./position.repository";
import type { ActivityService } from "./activity.service";
import {
  Position as PositionAggregate,
  type PositionAggregateDeps,
  type PositionResponse,
} from "./position.aggregate";
import { createRecoveryService } from "./recovery.service";
import { createDepositLpService } from "./position.deposit-lp.service";

export interface RecoverFundsUserSignedInput {
  positionId: string;
  /**
   * Solana signature of the user-signed `mixer.withdraw` tx the
   * browser already submitted. Recorded in the activity row so the
   * audit trail links to the on-chain artifact. Optional because the
   * frontend may broadcast in a degraded mode (e.g. local devnet
   * without confirmable signatures) and still want to mark the
   * Position WITHDRAWN.
   */
  withdrawSignature?: string;
  /**
   * Address that received the recovered funds (the user's fresh
   * stealth or origin wallet). Surfaced in the activity log so the
   * disclosure trail names the now-linked destination explicitly.
   */
  withdrawRecipient?: string;
}

/**
 * Caller asked to mark a Position WITHDRAWN from a state the dust/04
 * recovery flow doesn't permit. Surfaces a stable code so the route
 * layer can return 409 without sniffing message text. Strictly
 * narrower than dust/03's `DepositLpStateTransitionError`: that one
 * fires for *any* invalid LP-cluster transition, this one fires only
 * when dust/04's `LP_FAILED|PARKED → WITHDRAWN` precondition is
 * violated.
 */
export class InvalidRecoveryStateError extends Error {
  readonly code = "invalid_recovery_state";
  constructor(public readonly state: string) {
    super(
      `User-signed recovery is only available from LP_FAILED or PARKED, not ${state}.`,
    );
    this.name = "InvalidRecoveryStateError";
  }
}

/**
 * Drive an LP_FAILED or PARKED Position to the terminal WITHDRAWN state
 * with the user-signed-recovery audit trail.
 *
 * Does not perform any on-chain work — the user-signed mixer.withdraw
 * was already constructed, signed, and broadcast by the browser before
 * this is called. This function only records the state transition and
 * its activity row so the Position aggregate matches the on-chain
 * reality.
 *
 * Throws `InvalidRecoveryStateError` when the Position is not in
 * `LP_FAILED` or `PARKED`. The actual `advance(WITHDRAWN)` call is
 * delegated to dust/03's `DepositLpService.markWithdrawn` so the
 * state machine stays single-owner — see `position.deposit-lp.service`.
 */
export async function recoverFundsUserSigned(
  positionRepo: PositionRepository,
  activityService: ActivityService,
  input: RecoverFundsUserSignedInput,
): Promise<PositionResponse> {
  const recoveryService = createRecoveryService();
  const aggregateDeps: PositionAggregateDeps = {
    positionRepo,
    activityService,
    recoveryService,
  };

  // Load once to assert the precondition before delegating. We could
  // let the state-machine guard inside `markWithdrawn` raise — but
  // that throws a generic `DepositLpStateTransitionError`, which is
  // less specific than what callers need for the "this isn't a
  // recoverable Position" 409 path.
  const position = await PositionAggregate.load(aggregateDeps, input.positionId);
  if (position.state !== "LP_FAILED" && position.state !== "PARKED") {
    throw new InvalidRecoveryStateError(position.state);
  }

  // Record the user-signed evidence as a leading activity row so the
  // audit log captures *who* signed and *where* the funds went before
  // the terminal "Recovered" row from dust/03 lands. Keeping these as
  // two rows (rather than mutating dust/03's headline) preserves the
  // single-owner contract for the state-machine transition.
  await position.recordActivity("LP_FAILED" === position.state ? "LP_FAILED" : "PARKED", {
    headline: "User-signed recovery submitted",
    detail: buildRecoveryDetail(input),
    safeNextStep: "wait",
  });

  const depositLp = createDepositLpService({ positionRepo, activityService });
  return depositLp.markWithdrawn(input.positionId);
}

function buildRecoveryDetail(input: RecoverFundsUserSignedInput): string {
  const parts: string[] = [
    "User signed a mixer.withdraw directly and broadcast it without the backend relayer.",
  ];
  if (input.withdrawRecipient) {
    parts.push(`Funds routed to ${input.withdrawRecipient}.`);
  }
  if (input.withdrawSignature) {
    parts.push(`Signature: ${input.withdrawSignature}.`);
  }
  parts.push(
    "The origin wallet is now linkable to this withdraw destination on-chain — disclosure was surfaced before signing.",
  );
  return parts.join(" ");
}
