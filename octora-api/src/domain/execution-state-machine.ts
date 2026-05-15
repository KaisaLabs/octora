import type { ExecutionState } from "./position-intent";

export const transitions: Record<ExecutionState, readonly ExecutionState[]> = {
  draft: ["awaiting_signature"],
  awaiting_signature: ["funding_in_progress", "DEPOSITED", "failed"],
  funding_in_progress: ["executing_on_meteora", "DEPOSITED", "failed"],
  executing_on_meteora: ["indexing", "failed"],
  indexing: ["active", "completed", "failed"],
  active: ["claiming", "withdrawing", "closing", "CLOSING"],
  claiming: ["indexing", "completed", "failed"],
  withdrawing: ["closing", "failed"],
  closing: ["indexing", "completed", "failed"],
  completed: [],
  failed: [],
  DEPOSITED: ["LP_PENDING"],
  LP_PENDING: ["LP_FAILED", "LP_DONE"],
  LP_FAILED: ["LP_RETRIED", "PARKED", "WITHDRAWN"],
  LP_RETRIED: ["LP_PENDING", "LP_FAILED", "LP_DONE"],
  PARKED: ["LP_RETRIED", "WITHDRAWN"],
  WITHDRAWN: [],
  LP_DONE: [],
  // ── Private Position Close cluster (close/01) ─────────────────────
  // Mainline: active -> CLOSING -> (SWAPPING ->)? REMIXING -> CLOSED.
  // Each step's failure lands in its matching *_FAILED terminal so
  // the recovery panel can pick up the right Failure Stage. The
  // SWAPPING step is conditional — when the post-close residual of
  // the other-side token is at or below the dust threshold the
  // orchestrator transitions directly CLOSING -> REMIXING. Re-entry
  // from any *_FAILED back into the cluster is not permitted; the
  // user-signed close-recovery escape (close/03) drives those
  // terminals through a separate explicit transition added then.
  CLOSING: ["SWAPPING", "REMIXING", "CLOSE_FAILED"],
  // close/03 — user-signed close-recovery escape. Each *_FAILED terminal
  // permits an explicit transition to either CLOSED (the user signed the
  // remaining leg(s) and finished the close) or WITHDRAWN (the user
  // bailed: signed a sweep / mixer.withdraw straight to a destination
  // they control). No automatic re-entry into the cluster — those
  // transitions are driven exclusively by the close/03 recover-funds
  // entry point so the audit row + linkability disclosure are stamped.
  CLOSE_FAILED: ["CLOSED", "WITHDRAWN"],
  SWAPPING: ["REMIXING", "SWAP_FAILED"],
  SWAP_FAILED: ["CLOSED", "WITHDRAWN"],
  REMIXING: ["CLOSED", "REMIX_FAILED"],
  REMIX_FAILED: ["CLOSED", "WITHDRAWN"],
  CLOSED: [],
} as const;

export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  return transitions[from].includes(to);
}
