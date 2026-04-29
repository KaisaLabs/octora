import type { ActivityRecord, ExecutionMode, ExecutionState, PositionAction, PositionIntent } from "#domain";

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

export interface AddLiquidityWalkthrough {
  input: {
    amount: string;
    pool: string;
    mode: ExecutionMode;
  };
  pending: SubmitLiquidityResultShape;
  active: SubmitLiquidityResultShape;
}

export interface ClaimWithdrawWalkthrough {
  active: SubmitLiquidityResultShape;
  claimed: SubmitLiquidityResultShape;
  completed: SubmitLiquidityResultShape;
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

interface AddLiquidityOverrides {
  positionId?: string;
  amount?: string;
  pool?: string;
  poolLabel?: string;
  mode?: ExecutionMode;
  modeLabel?: string;
  createdAtIso?: string;
}

interface ClaimWithdrawOverrides {
  positionId?: string;
  amountLabel?: string;
  poolLabel?: string;
  modeLabel?: string;
  createdAtIso?: string;
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

export function createAddLiquidityWalkthrough(overrides: AddLiquidityOverrides = {}): AddLiquidityWalkthrough {
  const positionId = overrides.positionId ?? "position-1";
  const amount = overrides.amount ?? "1.25";
  const pool = overrides.pool ?? "sol-usdc";
  const poolLabel = overrides.poolLabel ?? "SOL / USDC";
  const mode = overrides.mode ?? "fast-private";
  const modeLabel = overrides.modeLabel ?? "Fast Private";
  const createdAtIso = overrides.createdAtIso ?? "2026-04-29T09:00:00.000Z";

  const received = createActivityRecord({
    id: `${positionId}-received`,
    positionId,
    action: "add-liquidity",
    state: "awaiting_signature",
    headline: "Intent received",
    detail: `We queued your ${modeLabel.toLowerCase()} position for ${poolLabel}.`,
    safeNextStep: "wait",
    createdAtIso,
  });

  const indexing = createActivityRecord({
    id: `${positionId}-indexing`,
    positionId,
    action: "add-liquidity",
    state: "indexing",
    headline: "Verifying final position state",
    detail: "Octora is holding the position in indexing until the final snapshot lands.",
    safeNextStep: "refresh",
    recovery: {
      headline: "Still waiting on the final snapshot",
      message: "The venue finished, but the final snapshot has not landed yet. Refresh this view in a moment.",
      safeNextStep: "refresh",
      terminal: false,
    },
    createdAtIso,
  });

  const active = createActivityRecord({
    id: `${positionId}-active`,
    positionId,
    action: "add-liquidity",
    state: "active",
    headline: "Position active",
    detail: "The final snapshot is available and the position is now live.",
    safeNextStep: "wait",
    createdAtIso,
  });

  return {
    input: { amount, pool, mode },
    pending: createSubmitLiquidityResult({
      intent: {
        id: `intent-${positionId}`,
        positionId,
        action: "add-liquidity",
        mode,
        state: "indexing",
        createdAtIso,
      },
      position: {
        id: positionId,
        poolLabel,
        amountLabel: `${formatAmount(amount)} SOL`,
        modeLabel,
        state: "indexing",
        statusLabel: "Verifying final position state",
      },
      activity: [received, indexing],
    }),
    active: createSubmitLiquidityResult({
      intent: {
        id: `intent-${positionId}`,
        positionId,
        action: "add-liquidity",
        mode,
        state: "active",
        createdAtIso,
      },
      position: {
        id: positionId,
        poolLabel,
        amountLabel: `${formatAmount(amount)} SOL`,
        modeLabel,
        state: "active",
        statusLabel: "Position active",
      },
      activity: [received, indexing, active],
    }),
  };
}

export function createClaimWithdrawWalkthrough(overrides: ClaimWithdrawOverrides = {}): ClaimWithdrawWalkthrough {
  const positionId = overrides.positionId ?? "position-1";
  const poolLabel = overrides.poolLabel ?? "SOL / USDC";
  const amountLabel = overrides.amountLabel ?? "1.25 SOL";
  const modeLabel = overrides.modeLabel ?? "Fast Private";
  const createdAtIso = overrides.createdAtIso ?? "2026-04-29T09:00:00.000Z";

  const received = createActivityRecord({
    id: `${positionId}-received`,
    positionId,
    action: "add-liquidity",
    state: "awaiting_signature",
    headline: "Intent received",
    detail: `We queued your ${modeLabel.toLowerCase()} position for ${poolLabel}.`,
    safeNextStep: "wait",
    createdAtIso,
  });

  const indexing = createActivityRecord({
    id: `${positionId}-indexing`,
    positionId,
    action: "add-liquidity",
    state: "indexing",
    headline: "Verifying final position state",
    detail: "Octora is holding the position in indexing until the final snapshot lands.",
    safeNextStep: "refresh",
    createdAtIso,
  });

  const active = createActivityRecord({
    id: `${positionId}-active`,
    positionId,
    action: "add-liquidity",
    state: "active",
    headline: "Position active",
    detail: "The final snapshot is available and the position is now live.",
    safeNextStep: "wait",
    createdAtIso,
  });

  const claimed = createActivityRecord({
    id: `${positionId}-claimed`,
    positionId,
    action: "claim",
    state: "active",
    headline: "Fees claimed",
    detail: "Fees were claimed and the position stays open.",
    safeNextStep: "wait",
    createdAtIso,
  });

  const completed = createActivityRecord({
    id: `${positionId}-withdraw-close`,
    positionId,
    action: "withdraw-close",
    state: "completed",
    headline: "Withdraw and close complete",
    detail: "The position was closed and the remaining funds returned.",
    safeNextStep: "wait",
    createdAtIso,
  });

  return {
    active: createSubmitLiquidityResult({
      intent: {
        id: `intent-${positionId}`,
        positionId,
        action: "add-liquidity",
        mode: "fast-private",
        state: "active",
        createdAtIso,
      },
      position: {
        id: positionId,
        poolLabel,
        amountLabel,
        modeLabel,
        state: "active",
        statusLabel: "Position active",
      },
      activity: [received, indexing, active],
    }),
    claimed: createSubmitLiquidityResult({
      intent: {
        id: `intent-${positionId}`,
        positionId,
        action: "claim",
        mode: "fast-private",
        state: "active",
        createdAtIso,
      },
      position: {
        id: positionId,
        poolLabel,
        amountLabel,
        modeLabel,
        state: "active",
        statusLabel: "Fees claimed",
      },
      activity: [received, indexing, active, claimed],
    }),
    completed: createSubmitLiquidityResult({
      intent: {
        id: `intent-${positionId}`,
        positionId,
        action: "withdraw-close",
        mode: "fast-private",
        state: "completed",
        createdAtIso,
      },
      position: {
        id: positionId,
        poolLabel,
        amountLabel,
        modeLabel,
        state: "completed",
        statusLabel: "Position closed",
      },
      activity: [received, indexing, active, claimed, completed],
    }),
  };
}

function formatAmount(amount: string) {
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : amount;
}
