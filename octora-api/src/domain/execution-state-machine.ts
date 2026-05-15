import type { ExecutionState } from "./position-intent";

export const transitions: Record<ExecutionState, readonly ExecutionState[]> = {
  draft: ["awaiting_signature"],
  awaiting_signature: ["funding_in_progress", "DEPOSITED", "failed"],
  funding_in_progress: ["executing_on_meteora", "DEPOSITED", "failed"],
  executing_on_meteora: ["indexing", "failed"],
  indexing: ["active", "completed", "failed"],
  active: ["claiming", "withdrawing", "closing"],
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
} as const;

export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  return transitions[from].includes(to);
}
