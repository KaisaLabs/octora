/**
 * Shared types and helpers for the three lifecycle services
 * (intent / execution / claim). Anything used by ≥2 of those files lives
 * here so the lifecycle files stay focused on one stage each.
 */
import {
  canTransition,
  modePolicy,
  type ActivityRecord,
  type ExecutionMode,
  type ExecutionState,
  type RecoveryGuidance,
  type PositionAction,
  type PositionIntent,
} from "#domain";

import { PositionNotFoundError, RateLimitedError } from "#common/errors";

import type { PositionRepository, PositionRow, ExecutionSessionRow } from "./position.repository";
import type { ActivityRow } from "./activity.repository";
import type { ActivityService } from "./activity.service";
import { createRecoveryService, type RecoveryServiceInput } from "./recovery.service";

import type { BetaCapsConfig } from "#common/config";

/** Default beta caps used when the service is constructed without explicit config. */
export const DEFAULT_BETA_CAPS: BetaCapsConfig = {
  maxPositionSol: 2.5,
  maxGlobalTvlSol: 125,
  maxPositionsPerWallet: 5,
};

export class BetaCapExceededError extends RateLimitedError {
  constructor(message: string) {
    super(message, { code: "beta_cap_exceeded" });
    this.name = "BetaCapExceededError";
  }
}

export interface PositionSessionState {
  id: string;
  positionId: string;
  state: ExecutionState;
  failureStage: string | null;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface PositionSnapshot {
  id: string;
  intentId: string;
  action: PositionAction;
  mode: ExecutionMode;
  modeLabel: string;
  state: ExecutionState;
  statusLabel: string;
  poolSlug: string;
  poolLabel: string;
  amount: string;
  amountLabel: string;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface PositionResponse {
  intent: PositionIntent;
  position: PositionSnapshot;
  session: PositionSessionState;
  activity: ActivityRecord[];
  recovery: RecoveryGuidance | null;
}

export function assertTransition(from: ExecutionState, to: ExecutionState) {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition from ${from} to ${to}`);
  }
}

export async function getActivePosition(positionRepo: PositionRepository, positionId: string) {
  const position = await positionRepo.getPositionById(positionId);
  if (!position) {
    throw new PositionNotFoundError(positionId);
  }

  if ((position.state as ExecutionState) !== "active") {
    throw new Error(`Position ${positionId} must be active before this action can run`);
  }

  return position;
}

export async function getLatestActiveSession(positionRepo: PositionRepository, positionId: string) {
  const session = await positionRepo.getLatestExecutionSession(positionId);
  if (!session) {
    throw new PositionNotFoundError(positionId);
  }

  if ((session.state as ExecutionState) !== "active") {
    throw new Error(`Execution session for ${positionId} must be active before this action can run`);
  }

  return session;
}

export function buildResponse(
  position: PositionRow,
  session: ExecutionSessionRow,
  activities: ActivityRow[],
  recoveryService = createRecoveryService(),
): PositionResponse {
  const mode = position.mode as ExecutionMode;
  const state = position.state as ExecutionState;
  const sessionState = session.state as ExecutionState;
  const latestActivity = activities.at(-1);
  const recovery = resolveRecovery(mode, session.failureStage, latestActivity, recoveryService);

  return {
    intent: {
      id: position.intentId,
      positionId: position.id,
      action: position.action as PositionAction,
      mode,
      state,
      createdAtIso: position.createdAt.toISOString(),
    },
    position: {
      id: position.id,
      intentId: position.intentId,
      action: position.action as PositionAction,
      mode,
      modeLabel: modePolicy[mode]?.label ?? mode,
      state,
      statusLabel: formatStatusLabel(state, latestActivity?.headline),
      poolSlug: position.poolSlug,
      poolLabel: formatPoolLabel(position.poolSlug),
      amount: position.amount,
      amountLabel: formatAmount(position.amount),
      createdAtIso: position.createdAt.toISOString(),
      updatedAtIso: position.updatedAt.toISOString(),
    },
    session: {
      id: session.id,
      positionId: session.positionId,
      state: sessionState,
      failureStage: session.failureStage,
      createdAtIso: session.createdAt.toISOString(),
      updatedAtIso: session.updatedAt.toISOString(),
    },
    activity: activities.map((item) => ({
      id: item.id,
      positionId: item.positionId,
      action: item.action as PositionAction,
      state: item.state as ActivityRecord["state"],
      headline: item.headline,
      detail: item.detail,
      safeNextStep: item.safeNextStep as ActivityRecord["safeNextStep"],
      recovery: resolveActivityRecovery(item, session.failureStage, mode, recoveryService, latestActivity?.id === item.id),
      createdAtIso: item.createdAt.toISOString(),
    })),
    recovery,
  };
}

export function formatPoolLabel(poolSlug: string) {
  if (poolSlug === "sol-usdc") return "SOL / USDC";
  return poolSlug.toUpperCase();
}

export function formatAmount(amount: string) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return amount;

  return `${parsed.toFixed(2).replace(/\.00$/, ".00")} SOL`;
}

function formatStatusLabel(state: ExecutionState, latestHeadline?: string) {
  switch (state) {
    case "draft":
      return "Awaiting signature";
    case "awaiting_signature":
      return "Waiting for signature";
    case "funding_in_progress":
      return "Funding in progress";
    case "executing_on_meteora":
      return "Executing on Meteora";
    case "indexing":
      return latestHeadline === "Execution delayed" ? "Execution delayed" : "Verifying final position state";
    case "active":
      return "Position active";
    case "claiming":
      return "Claiming";
    case "withdrawing":
      return "Withdrawing";
    case "closing":
      return "Closing";
    case "completed":
      return "Completed";
    case "failed":
      return latestHeadline ?? "Needs attention";
  }
}

function resolveRecovery(
  mode: ExecutionMode,
  failureStage: string | null,
  latestActivity: ActivityRow | undefined,
  recoveryService: ReturnType<typeof createRecoveryService>,
): RecoveryGuidance | null {
  if (failureStage) {
    return recoveryService.getRecoveryGuidance({ failureStage: failureStage as RecoveryServiceInput["failureStage"], mode });
  }

  return resolveActivityRecovery(latestActivity, null, mode, recoveryService, true);
}

function resolveActivityRecovery(
  activity: ActivityRow | undefined,
  failureStage: string | null,
  mode: ExecutionMode,
  recoveryService: ReturnType<typeof createRecoveryService>,
  isLatestActivity: boolean,
): RecoveryGuidance | null {
  if (failureStage && isLatestActivity) {
    return recoveryService.getRecoveryGuidance({ failureStage: failureStage as RecoveryServiceInput["failureStage"], mode });
  }

  if (activity?.state === "indexing" && activity.headline === "Execution delayed") {
    return recoveryService.getIndexingRecovery();
  }

  if (activity?.state === "failed") {
    return recoveryService.getRecoveryGuidance({ failureStage: "recovery-required", mode: "fast-private" });
  }

  return null;
}

export async function recordFailure(
  positionRepo: PositionRepository,
  activityService: ActivityService,
  recoveryService: ReturnType<typeof createRecoveryService>,
  position: PositionRow,
  failureStage: RecoveryServiceInput["failureStage"],
  error: unknown,
) {
  const guidance =
    recoveryService.getRecoveryGuidance({ failureStage, mode: position.mode as ExecutionMode }) ??
    recoveryService.getRecoveryGuidance({ failureStage: "recovery-required", mode: position.mode as ExecutionMode });
  const failedPosition = await positionRepo.updatePositionState(position.id, "failed");
  const failedSession = await positionRepo.updateExecutionSession(position.id, "failed", failureStage);

  await activityService.record(
    failedPosition,
    "failed",
    guidance?.headline ?? "Needs attention",
    guidance?.message ?? formatFailureMessage(error),
    guidance?.safeNextStep ?? "contact-support",
  );

  return buildResponse(failedPosition, failedSession, await activityService.list(position.id), recoveryService);
}

function formatFailureMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Octora stopped safely and needs another pass.";
}
