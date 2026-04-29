import type { ExecutionState } from "./position-intent";

export const transitions: Record<ExecutionState, readonly ExecutionState[]> = {
  draft: ["awaiting_signature"],
  awaiting_signature: ["funding_in_progress", "failed"],
  funding_in_progress: ["executing_on_meteora", "failed"],
  executing_on_meteora: ["indexing", "failed"],
  indexing: ["active", "completed", "failed"],
  active: ["claiming", "withdrawing", "closing"],
  claiming: ["indexing", "completed", "failed"],
  withdrawing: ["closing", "failed"],
  closing: ["indexing", "completed", "failed"],
  completed: [],
  failed: [],
} as const;

export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  return transitions[from].includes(to);
}
