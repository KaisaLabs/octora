export type ExecutionMode = "standard" | "fast-private";

export type PositionAction = "add-liquidity" | "claim" | "withdraw-close";

export type ExecutionState =
  | "draft"
  | "awaiting_signature"
  | "funding_in_progress"
  | "executing_on_meteora"
  | "indexing"
  | "active"
  | "claiming"
  | "withdrawing"
  | "closing"
  | "completed"
  | "failed"
  | "DEPOSITED"
  | "LP_PENDING"
  | "LP_FAILED"
  | "LP_RETRIED"
  | "PARKED"
  | "WITHDRAWN"
  | "LP_DONE"
  // ── Private Position Close cluster (close/01) ─────────────────────
  // Drives an `active` Position through the three-tx close-flow
  // mainline: `dlmm_withdraw_close` -> conditional `dlmm_swap` ->
  // `mixer.deposit`. The cluster ships as named variants of the
  // existing `ExecutionState` union (same option (a) precedent the
  // Deposit LP Fallback cluster used) so the existing `canTransition`
  // guard rejects illegal jumps without a second state machine.
  | "CLOSING"
  | "CLOSE_FAILED"
  | "SWAPPING"
  | "SWAP_FAILED"
  | "REMIXING"
  | "REMIX_FAILED"
  | "CLOSED";

export type FailureStage =
  | "signature"
  | "pre-funding"
  | "funding-partial"
  | "venue-submission"
  | "venue-confirmation"
  | "indexing-lag"
  | "recovery-required"
  // ── Private Position Close failure stages (close/01) ──────────────
  // One per relayer-signed leg of the close mainline. No Mode Fallback
  // (the close flow has no fast-private/standard split — Mode Fallback
  // is a deposit-only concept), no `surfaceDowngradeDisclosure`. The
  // user-signed close-recovery escape lands in close/03; until then
  // `safeNextStep: contact-support` is the honest answer.
  | "close-submission"
  | "swap-submission"
  | "remix-submission";

export interface PositionIntent {
  id: string;
  positionId?: string;
  action: PositionAction;
  mode: ExecutionMode;
  state: ExecutionState;
  failureStage?: FailureStage;
  createdAtIso: string;
}

export interface PersistedDepositIntent {
  nullifierHash: string;
  commitment: string;
  intendedPool: string;
  denom: string;
  expiresAtIso: string;
}

export function isTerminalDepositLpState(state: ExecutionState): boolean {
  return state === "LP_DONE" || state === "WITHDRAWN";
}
