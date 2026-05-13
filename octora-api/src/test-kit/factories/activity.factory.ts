import type { ActivityRecord, ExecutionState, PositionAction } from "#domain";

interface BaseActivityOverrides {
  id?: string;
  positionId?: string;
  action?: PositionAction;
  state?: ExecutionState;
  headline?: string;
  detail?: string;
  safeNextStep?: ActivityRecord["safeNextStep"];
  createdAtIso?: string;
  recovery?: ActivityRecord["recovery"];
}

export function createActivityRecord(overrides: BaseActivityOverrides = {}): ActivityRecord {
  const positionId = overrides.positionId ?? "position-1";

  return {
    id: overrides.id ?? `${positionId}-${overrides.action ?? "add-liquidity"}-${overrides.state ?? "indexing"}`,
    positionId,
    action: overrides.action ?? "add-liquidity",
    state: overrides.state ?? "indexing",
    headline: overrides.headline ?? "Verifying final position state",
    detail: overrides.detail ?? "Octora is holding the position in indexing until the final snapshot lands.",
    safeNextStep: overrides.safeNextStep ?? "refresh",
    recovery: overrides.recovery,
    createdAtIso: overrides.createdAtIso ?? "2026-04-29T09:00:00.000Z",
  };
}
