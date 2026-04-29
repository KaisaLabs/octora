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
  | "failed";

export type FailureStage =
  | "signature"
  | "pre-funding"
  | "funding-partial"
  | "venue-submission"
  | "venue-confirmation"
  | "indexing-lag"
  | "recovery-required";

export interface PositionIntent {
  id: string;
  positionId?: string;
  action: PositionAction;
  mode: ExecutionMode;
  state: ExecutionState;
  failureStage?: FailureStage;
  createdAtIso: string;
}
