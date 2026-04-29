import { randomUUID } from "node:crypto";

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
import { createPositionIndexer, type PositionIndexer } from "#indexer";
import { createMockMeteoraExecutor, type MeteoraExecutor } from "#clients";
import { MockPrivacyAdapter, type PrivacyAdapter } from "#adapters";

import type { ActivityRow, ExecutionSessionRow, OrchestratorDb, PositionRow } from "../db";
import { createRecoveryService, type RecoveryServiceInput } from "./recovery.service";

export interface CreateDraftPositionIntentInput {
  action: PositionAction;
  amount: string;
  pool: string;
  mode: ExecutionMode;
}

export interface ExecuteSignedIntentInput {
  positionId: string;
  signedMessage: string;
}

export interface ClaimPositionInput {
  positionId: string;
}

export interface WithdrawClosePositionInput {
  positionId: string;
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

export interface OrchestratorServiceDependencies {
  privacyAdapter?: PrivacyAdapter;
  meteoraExecutor?: MeteoraExecutor;
  positionIndexer?: PositionIndexer;
  recoveryService?: ReturnType<typeof createRecoveryService>;
}

export class PositionNotFoundError extends Error {
  constructor(positionId: string) {
    super(`Position ${positionId} not found`);
    this.name = "PositionNotFoundError";
  }
}

export class UnsupportedPositionActionError extends Error {
  constructor(action: PositionAction) {
    super(`Task 7 only implements add-liquidity execution, not ${action}`);
    this.name = "UnsupportedPositionActionError";
  }
}

export function createPositionService(db: OrchestratorDb, dependencies: OrchestratorServiceDependencies = {}) {
  const privacyAdapter = dependencies.privacyAdapter ?? new MockPrivacyAdapter();
  const meteoraExecutor = dependencies.meteoraExecutor ?? createMockMeteoraExecutor();
  const positionIndexer = dependencies.positionIndexer ?? createPositionIndexer({ store: db });
  const recoveryService = dependencies.recoveryService ?? createRecoveryService();

  return {
    createDraftPositionIntent(input: CreateDraftPositionIntentInput): Promise<PositionResponse> {
      return createDraftPositionIntent(db, input);
    },
    executeSignedIntent(input: ExecuteSignedIntentInput): Promise<PositionResponse> {
      return executeSignedIntent(db, privacyAdapter, meteoraExecutor, positionIndexer, recoveryService, input);
    },
    claimPosition(input: ClaimPositionInput): Promise<PositionResponse> {
      return claimPosition(db, privacyAdapter, meteoraExecutor, input);
    },
    withdrawClosePosition(input: WithdrawClosePositionInput): Promise<PositionResponse> {
      return withdrawClosePosition(db, privacyAdapter, meteoraExecutor, input);
    },
    getPosition(positionId: string): Promise<PositionResponse> {
      return getPosition(db, positionIndexer, positionId);
    },
  };
}

export async function createDraftPositionIntent(db: OrchestratorDb, input: CreateDraftPositionIntentInput): Promise<PositionResponse> {
  const positionId = randomUUID();
  const intentId = randomUUID();
  const sessionId = randomUUID();

  const position = await db.createPosition({
    id: positionId,
    intentId,
    action: input.action,
    mode: input.mode,
    state: "draft",
    poolSlug: input.pool,
    amount: input.amount,
  });

  const session = await db.createExecutionSession({
    id: sessionId,
    positionId,
    state: "awaiting_signature",
    failureStage: null,
  });

  const activity = await db.createActivity({
    id: randomUUID(),
    positionId,
    action: input.action,
    state: "awaiting_signature",
    headline: "Intent received",
    detail: `Queued a draft ${formatPoolLabel(input.pool)} position for signature review.`,
    safeNextStep: "wait",
  });

  return buildResponse(position, session, [activity]);
}

export async function executeSignedIntent(
  db: OrchestratorDb,
  privacyAdapter: PrivacyAdapter,
  meteoraExecutor: MeteoraExecutor,
  positionIndexer: PositionIndexer,
  recoveryService: ReturnType<typeof createRecoveryService>,
  input: ExecuteSignedIntentInput,
): Promise<PositionResponse> {
  if (!input.signedMessage.length) {
    throw new Error("Signed message is required");
  }

  const position = await db.getPositionById(input.positionId);
  if (!position) {
    throw new PositionNotFoundError(input.positionId);
  }

  const session = await db.getLatestExecutionSession(input.positionId);
  if (!session) {
    throw new PositionNotFoundError(input.positionId);
  }

  if (position.action !== "add-liquidity") {
    throw new UnsupportedPositionActionError(position.action as PositionAction);
  }

  const executionMode = recoveryService.resolveExecutionMode({
    selectedMode: position.mode as ExecutionMode,
    surfacedFallback: false,
  }).mode;

  assertTransition(session.state as ExecutionState, "funding_in_progress");
  const fundingSession = await db.updateExecutionSession(input.positionId, "funding_in_progress");
  await recordActivity(db, position, "funding_in_progress", "Funding started", `Routing ${formatAmount(position.amount)} into the execution boundary.`, "wait");

  let fundingReceipt;
  try {
    fundingReceipt = await privacyAdapter.prepareFunding({
      positionId: position.id,
      intentId: position.intentId,
      poolSlug: position.poolSlug,
      amount: position.amount,
      mode: executionMode,
    });
  } catch (error) {
    return recordFailure(db, recoveryService, position, "pre-funding", error);
  }

  assertTransition(fundingSession.state as ExecutionState, "executing_on_meteora");
  const executingSession = await db.updateExecutionSession(input.positionId, "executing_on_meteora");
  await recordActivity(
    db,
    position,
    "executing_on_meteora",
    "Submitting to Meteora",
    `Prepared the execution pod ${fundingReceipt.podId ?? "unknown"} for onchain submission.`,
    "wait",
  );

  let venueReceipt;
  try {
    venueReceipt = await meteoraExecutor.addLiquidity({
      podId: fundingReceipt.podId ?? position.id,
      amountSol: position.amount,
    });
  } catch (error) {
    return recordFailure(db, recoveryService, position, "funding-partial", error);
  }

  assertTransition(executingSession.state as ExecutionState, "indexing");
  positionIndexer.beginReconciliation({ positionId: position.id });
  const indexingPosition = await db.updatePositionState(input.positionId, "indexing");
  const indexingSession = await db.updateExecutionSession(input.positionId, "indexing");
  await recordActivity(
    db,
    indexingPosition,
    "indexing",
    "Verifying final position state",
    `Meteora returned ${venueReceipt.signature}; Octora is checking the final position state before activating it.`,
    "wait",
  );
  positionIndexer.registerSnapshot({ positionId: position.id, signature: venueReceipt.signature });

  return buildResponse(indexingPosition, indexingSession, await db.listActivities(input.positionId), recoveryService);
}

export async function claimPosition(
  db: OrchestratorDb,
  privacyAdapter: PrivacyAdapter,
  meteoraExecutor: MeteoraExecutor,
  input: ClaimPositionInput,
): Promise<PositionResponse> {
  const recoveryService = createRecoveryService();
  const position = await getActivePosition(db, input.positionId);
  const session = await getLatestActiveSession(db, input.positionId);

  const executionMode = recoveryService.resolveExecutionMode({
    selectedMode: position.mode as ExecutionMode,
    surfacedFallback: false,
  }).mode;

  assertTransition(session.state as ExecutionState, "claiming");
  const claimingPosition = await db.updatePositionState(position.id, "claiming");
  const claimingSession = await db.updateExecutionSession(input.positionId, "claiming");
  await recordActivity(
    db,
    claimingPosition,
    "claiming",
    "Claiming fees",
    "Octora is claiming the available fees and keeping the position flow private.",
    "wait",
  );

  let exitReceipt;
  try {
    exitReceipt = await privacyAdapter.prepareExit({
      positionId: position.id,
      intentId: position.intentId,
      mode: executionMode,
    });
  } catch (error) {
    return recordFailure(db, recoveryService, position, "venue-submission", error);
  }

  let venueReceipt;
  try {
    venueReceipt = await meteoraExecutor.claim({
      podId: exitReceipt.podId ?? position.id,
      positionId: position.id,
    });
  } catch (error) {
    return recordFailure(db, recoveryService, position, "venue-confirmation", error);
  }

  assertTransition(claimingSession.state as ExecutionState, "indexing");
  const indexingPosition = await db.updatePositionState(position.id, "indexing");
  const indexingSession = await db.updateExecutionSession(input.positionId, "indexing");
  await recordActivity(
    db,
    indexingPosition,
    "indexing",
    "Reconciling claim",
    `Meteora returned ${venueReceipt.signature}; Octora is reconciling the claim before finishing the flow.`,
    "wait",
  );

  assertTransition(indexingSession.state as ExecutionState, "completed");
  const completedPosition = await db.updatePositionState(position.id, "completed");
  const completedSession = await db.updateExecutionSession(input.positionId, "completed");
  await recordActivity(
    db,
    completedPosition,
    "completed",
    "Claim completed",
    "Fees have been claimed and the position is settled.",
    "wait",
  );

  return buildResponse(completedPosition, completedSession, await db.listActivities(input.positionId), recoveryService);
}

export async function withdrawClosePosition(
  db: OrchestratorDb,
  privacyAdapter: PrivacyAdapter,
  meteoraExecutor: MeteoraExecutor,
  input: WithdrawClosePositionInput,
): Promise<PositionResponse> {
  const recoveryService = createRecoveryService();
  const position = await getActivePosition(db, input.positionId);
  const session = await getLatestActiveSession(db, input.positionId);

  const executionMode = recoveryService.resolveExecutionMode({
    selectedMode: position.mode as ExecutionMode,
    surfacedFallback: false,
  }).mode;

  assertTransition(session.state as ExecutionState, "withdrawing");
  const withdrawingPosition = await db.updatePositionState(position.id, "withdrawing");
  const withdrawingSession = await db.updateExecutionSession(input.positionId, "withdrawing");
  await recordActivity(
    db,
    withdrawingPosition,
    "withdrawing",
    "Withdrawing liquidity",
    "Octora is removing the position through the private execution boundary.",
    "wait",
  );

  let exitReceipt;
  try {
    exitReceipt = await privacyAdapter.prepareExit({
      positionId: position.id,
      intentId: position.intentId,
      mode: executionMode,
    });
  } catch (error) {
    return recordFailure(db, recoveryService, position, "venue-submission", error);
  }

  let venueReceipt;
  try {
    venueReceipt = await meteoraExecutor.withdrawClose({
      podId: exitReceipt.podId ?? position.id,
      positionId: position.id,
    });
  } catch (error) {
    return recordFailure(db, recoveryService, position, "venue-confirmation", error);
  }

  assertTransition(withdrawingSession.state as ExecutionState, "closing");
  const closingPosition = await db.updatePositionState(position.id, "closing");
  const closingSession = await db.updateExecutionSession(input.positionId, "closing");
  await recordActivity(
    db,
    closingPosition,
    "closing",
    "Closing position",
    `Meteora returned ${venueReceipt.signature}; Octora is finalizing the close and reconciling balances.`,
    "wait",
  );

  assertTransition(closingSession.state as ExecutionState, "indexing");
  const indexingPosition = await db.updatePositionState(position.id, "indexing");
  const indexingSession = await db.updateExecutionSession(input.positionId, "indexing");
  await recordActivity(
    db,
    indexingPosition,
    "indexing",
    "Reconciling exit",
    "Octora is checking the final position state before marking the exit complete.",
    "wait",
  );

  assertTransition(indexingSession.state as ExecutionState, "completed");
  const completedPosition = await db.updatePositionState(position.id, "completed");
  const completedSession = await db.updateExecutionSession(input.positionId, "completed");
  await recordActivity(
    db,
    completedPosition,
    "completed",
    "Withdraw-close completed",
    "Your position has been withdrawn and closed.",
    "wait",
  );

  return buildResponse(completedPosition, completedSession, await db.listActivities(input.positionId), recoveryService);
}

export async function getPosition(db: OrchestratorDb, positionIndexer: PositionIndexer, positionId: string): Promise<PositionResponse> {
  const position = await db.getPositionById(positionId);
  if (!position) {
    throw new PositionNotFoundError(positionId);
  }

  const session = await db.getLatestExecutionSession(positionId);
  if (!session) {
    throw new PositionNotFoundError(positionId);
  }

  let activities = await db.listActivities(positionId);
  const recoveryService = createRecoveryService();

  if ((session.state as ExecutionState) === "indexing") {
    const reconciliation = await positionIndexer.reconcile(positionId);

    if (reconciliation.state === "active" && (position.state as ExecutionState) !== "active") {
      const activePosition = await db.updatePositionState(positionId, "active");
      const activeSession = await db.updateExecutionSession(positionId, "active");
      await recordActivity(
        db,
        activePosition,
        "active",
        "Position active",
        "The final snapshot is available and the position is now live.",
        "wait",
      );

      return buildResponse(activePosition, activeSession, await db.listActivities(positionId), recoveryService);
    }

    if (activities.at(-1)?.headline !== "Execution delayed") {
      const indexingRecovery = recoveryService.getIndexingRecovery();
      await recordActivity(
        db,
        position,
        "indexing",
        "Execution delayed",
        indexingRecovery.message,
        indexingRecovery.safeNextStep,
      );
      activities = await db.listActivities(positionId);
    }
  }

  return buildResponse(position, session, activities, recoveryService);
}

function assertTransition(from: ExecutionState, to: ExecutionState) {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition from ${from} to ${to}`);
  }
}

async function getActivePosition(db: OrchestratorDb, positionId: string) {
  const position = await db.getPositionById(positionId);
  if (!position) {
    throw new PositionNotFoundError(positionId);
  }

  if ((position.state as ExecutionState) !== "active") {
    throw new Error(`Position ${positionId} must be active before this action can run`);
  }

  return position;
}

async function getLatestActiveSession(db: OrchestratorDb, positionId: string) {
  const session = await db.getLatestExecutionSession(positionId);
  if (!session) {
    throw new PositionNotFoundError(positionId);
  }

  if ((session.state as ExecutionState) !== "active") {
    throw new Error(`Execution session for ${positionId} must be active before this action can run`);
  }

  return session;
}

async function recordActivity(
  db: OrchestratorDb,
  position: PositionRow,
  state: ExecutionState,
  headline: string,
  detail: string,
  safeNextStep: ActivityRecord["safeNextStep"],
) {
  await db.createActivity({
    id: randomUUID(),
    positionId: position.id,
    action: position.action as PositionAction,
    state,
    headline,
    detail,
    safeNextStep,
  });
}

function buildResponse(
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
      createdAtIso: item.createdAt.toISOString(),
      recovery: resolveActivityRecovery(item, session.failureStage, mode, recoveryService, latestActivity?.id === item.id),
    })),
    recovery,
  };
}

function formatPoolLabel(poolSlug: string) {
  if (poolSlug === "sol-usdc") return "SOL / USDC";
  return poolSlug.toUpperCase();
}

function formatAmount(amount: string) {
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

async function recordFailure(
  db: OrchestratorDb,
  recoveryService: ReturnType<typeof createRecoveryService>,
  position: PositionRow,
  failureStage: RecoveryServiceInput["failureStage"],
  error: unknown,
) {
  const guidance = recoveryService.getRecoveryGuidance({ failureStage, mode: position.mode as ExecutionMode }) ?? recoveryService.getRecoveryGuidance({ failureStage: "recovery-required", mode: position.mode as ExecutionMode });
  const failedPosition = await db.updatePositionState(position.id, "failed");
  const failedSession = await db.updateExecutionSession(position.id, "failed", failureStage);

  await recordActivity(
    db,
    failedPosition,
    "failed",
    guidance?.headline ?? "Needs attention",
    guidance?.message ?? formatFailureMessage(error),
    guidance?.safeNextStep ?? "contact-support",
  );

  return buildResponse(failedPosition, failedSession, await db.listActivities(position.id), recoveryService);
}

function formatFailureMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Octora stopped safely and needs another pass.";
}
