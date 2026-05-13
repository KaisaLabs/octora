import type { ExecutionMode, ExecutionState, PositionAction, PositionIntent } from "#domain";
import type { ActivityRecord } from "#domain";

export interface ActivePositionViewShape {
  id: string;
  poolLabel: string;
  amountLabel: string;
  modeLabel: string;
  state: ExecutionState;
  statusLabel: string;
}

export interface SubmitLiquidityResultShape {
  intent: PositionIntent;
  position: ActivePositionViewShape;
  activity: ActivityRecord[];
}

interface BaseIntentOverrides {
  id?: string;
  positionId?: string;
  action?: PositionAction;
  mode?: ExecutionMode;
  state?: ExecutionState;
  createdAtIso?: string;
}

interface BasePositionOverrides {
  id?: string;
  poolLabel?: string;
  amountLabel?: string;
  modeLabel?: string;
  state?: ExecutionState;
  statusLabel?: string;
}

export function createPositionIntent(overrides: BaseIntentOverrides = {}): PositionIntent {
  const positionId = overrides.positionId ?? "position-1";
  const action = overrides.action ?? "add-liquidity";
  const mode = overrides.mode ?? "fast-private";
  const state = overrides.state ?? "indexing";

  return {
    id: overrides.id ?? `intent-${positionId}`,
    positionId,
    action,
    mode,
    state,
    createdAtIso: overrides.createdAtIso ?? "2026-04-29T09:00:00.000Z",
  };
}

export function createActivePositionView(overrides: BasePositionOverrides = {}): ActivePositionViewShape {
  return {
    id: overrides.id ?? "position-1",
    poolLabel: overrides.poolLabel ?? "SOL / USDC",
    amountLabel: overrides.amountLabel ?? "1.25 SOL",
    modeLabel: overrides.modeLabel ?? "Fast Private",
    state: overrides.state ?? "active",
    statusLabel: overrides.statusLabel ?? "Position active",
  };
}

export function createSubmitLiquidityResult(overrides: {
  intent?: BaseIntentOverrides;
  position?: BasePositionOverrides;
  activity?: ActivityRecord[];
} = {}): SubmitLiquidityResultShape {
  return {
    intent: createPositionIntent(overrides.intent),
    position: createActivePositionView(overrides.position),
    activity: overrides.activity ?? [],
  };
}
