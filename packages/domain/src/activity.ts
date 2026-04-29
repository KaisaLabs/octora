import type { ExecutionState, PositionAction } from "./position-intent";

export interface ActivityRecord {
  id: string;
  positionId: string;
  action: PositionAction;
  state: ExecutionState;
  headline: string;
  detail: string;
  safeNextStep: "wait" | "retry" | "refresh" | "contact-support";
  createdAtIso: string;
}
