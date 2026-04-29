import type { ExecutionState, PositionAction } from "./position-intent";
import type { RecoveryGuidance, RecoverySafeNextStep } from "./recovery";

export interface ActivityRecord {
  id: string;
  positionId: string;
  action: PositionAction;
  state: ExecutionState;
  headline: string;
  detail: string;
  safeNextStep: RecoverySafeNextStep;
  recovery?: RecoveryGuidance | null;
  createdAtIso: string;
}
