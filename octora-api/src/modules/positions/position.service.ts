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

import { MockPrivacyAdapter, type PrivacyAdapter } from "#modules/execution/adapters";
import { createMockMeteoraExecutor, type MeteoraExecutor } from "#modules/execution/clients";
import { createIndexerService, type PositionIndexer } from "#modules/indexer";
import type { ReconciliationRepository } from "#modules/indexer/indexer.repository";

import { PositionNotFoundError, UnsupportedPositionActionError } from "#common/errors";

import type { PositionRepository, PositionRow, ExecutionSessionRow } from "./position.repository";
import type { ActivityRepository, ActivityRow } from "./activity.repository";
import { createActivityService, type ActivityService } from "./activity.service";
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

export interface PositionServiceDependencies {
  positionRepo: PositionRepository;
  activityRepo: ActivityRepository;
  reconciliationRepo?: ReconciliationRepository;
  privacyAdapter?: PrivacyAdapter;
  meteoraExecutor?: MeteoraExecutor;
  positionIndexer?: PositionIndexer;
  recoveryService?: ReturnType<typeof createRecoveryService>;
}

export { PositionNotFoundError, UnsupportedPositionActionError };

export function createPositionService(deps: PositionServiceDependencies) {
  const positionRepo = deps.positionRepo;
  const activityRepo = deps.activityRepo;
  const activityService = createActivityService(activityRepo);
  const privacyAdapter = deps.privacyAdapter ?? new MockPrivacyAdapter();
  const meteoraExecutor = deps.meteoraExecutor ?? createMockMeteoraExecutor();
  const positionIndexer = deps.positionIndexer ?? createIndexerService({ store: deps.reconciliationRepo! });
  const recoveryService = deps.recoveryService ?? createRecoveryService();

  return {
    createDraftPositionIntent(input: CreateDraftPositionIntentInput): Promise<PositionResponse> {
      return createDraftPositionIntent(positionRepo, activityService, input);
    },
    executeSignedIntent(input: ExecuteSignedIntentInput): Promise<PositionResponse> {
      return executeSignedIntent(positionRepo, activityService, privacyAdapter, meteoraExecutor, positionIndexer, recoveryService, input);
    },
    claimPosition(input: ClaimPositionInput): Promise<PositionResponse> {
      return claimPosition(positionRepo, activityService, privacyAdapter, meteoraExecutor, input);
    },
    withdrawClosePosition(input: WithdrawClosePositionInput): Promise<PositionResponse> {
      return withdrawClosePosition(positionRepo, activityService, privacyAdapter, meteoraExecutor, input);
    },
    getPosition(positionId: string): Promise<PositionResponse> {
      return getPosition(positionRepo, activityService, positionIndexer, positionId);
    },
  };
}

async function createDraftPositionIntent(
  positionRepo: PositionRepository,
  activityService: ActivityService,
  input: CreateDraftPositionIntentInput,
): Promise<PositionResponse> {
  const positionId = randomUUID();
  const intentId = randomUUID();
  const sessionId = randomUUID();

  const position = await positionRepo.createPosition({
    id: positionId,
    intentId,
    action: input.action,
    mode: input.mode,
    state: "draft",
    poolSlug: input.pool,
    amount: input.amount,
  });

  const session = await positionRepo.createExecutionSession({
    id: sessionId,
    positionId,
    state: "awaiting_signature",
    failureStage: null,
  });

  const activity = await activityService.record(
    position,
    "awaiting_signature",
    "Intent received",
    `Queued a draft ${formatPoolLabel(input.pool)} position for signature review.`,
    "wait",
  );

  return buildResponse(position, session, [activity]);
}

async function executeSignedIntent(
  positionRepo: PositionRepository,
  activityService: ActivityService,
  privacyAdapter: PrivacyAdapter,
  meteoraExecutor: MeteoraExecutor,
  positionIndexer: PositionIndexer,
  recoveryService: ReturnType<typeof createRecoveryService>,
  input: ExecuteSignedIntentInput,
): Promise<PositionResponse> {
  if (!input.signedMessage.length) {
    throw new Error("Signed message is required");
  }

  const position = await positionRepo.getPositionById(input.positionId);
  if (!position) {
    throw new PositionNotFoundError(input.positionId);
  }

  const session = await positionRepo.getLatestExecutionSession(input.positionId);
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
  const fundingSession = await positionRepo.updateExecutionSession(input.positionId, "funding_in_progress");
  await activityService.record(position, "funding_in_progress", "Funding started", `Routing ${formatAmount(position.amount)} into the execution boundary.`, "wait");

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
    return recordFailure(positionRepo, activityService, recoveryService, position, "pre-funding", error);
  }

  assertTransition(fundingSession.state as ExecutionState, "executing_on_meteora");
  const executingSession = await positionRepo.updateExecutionSession(input.positionId, "executing_on_meteora");
  await activityService.record(
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
    return recordFailure(positionRepo, activityService, recoveryService, position, "funding-partial", error);
  }

  assertTransition(executingSession.state as ExecutionState, "indexing");
  positionIndexer.beginReconciliation({ positionId: position.id });
  const indexingPosition = await positionRepo.updatePositionState(input.positionId, "indexing");
  const indexingSession = await positionRepo.updateExecutionSession(input.positionId, "indexing");
  await activityService.record(
    indexingPosition,
    "indexing",
    "Verifying final position state",
    `Meteora returned ${venueReceipt.signature}; Octora is checking the final position state before activating it.`,
    "wait",
  );
  positionIndexer.registerSnapshot({ positionId: position.id, signature: venueReceipt.signature });

  return buildResponse(indexingPosition, indexingSession, await activityService.list(input.positionId), recoveryService);
}

async function claimPosition(
  positionRepo: PositionRepository,
  activityService: ActivityService,
  privacyAdapter: PrivacyAdapter,
  meteoraExecutor: MeteoraExecutor,
  input: ClaimPositionInput,
): Promise<PositionResponse> {
  const recoveryService = createRecoveryService();
  const position = await getActivePosition(positionRepo, input.positionId);
  const session = await getLatestActiveSession(positionRepo, input.positionId);

  const executionMode = recoveryService.resolveExecutionMode({
    selectedMode: position.mode as ExecutionMode,
    surfacedFallback: false,
  }).mode;

  assertTransition(session.state as ExecutionState, "claiming");
  const claimingPosition = await positionRepo.updatePositionState(position.id, "claiming");
  const claimingSession = await positionRepo.updateExecutionSession(input.positionId, "claiming");
  await activityService.record(
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
    return recordFailure(positionRepo, activityService, recoveryService, position, "venue-submission", error);
  }

  let venueReceipt;
  try {
    venueReceipt = await meteoraExecutor.claim({
      podId: exitReceipt.podId ?? position.id,
      positionId: position.id,
    });
  } catch (error) {
    return recordFailure(positionRepo, activityService, recoveryService, position, "venue-confirmation", error);
  }

  assertTransition(claimingSession.state as ExecutionState, "indexing");
  const indexingPosition = await positionRepo.updatePositionState(position.id, "indexing");
  const indexingSession = await positionRepo.updateExecutionSession(input.positionId, "indexing");
  await activityService.record(
    indexingPosition,
    "indexing",
    "Reconciling claim",
    `Meteora returned ${venueReceipt.signature}; Octora is reconciling the claim before finishing the flow.`,
    "wait",
  );

  assertTransition(indexingSession.state as ExecutionState, "completed");
  const completedPosition = await positionRepo.updatePositionState(position.id, "completed");
  const completedSession = await positionRepo.updateExecutionSession(input.positionId, "completed");
  await activityService.record(
    completedPosition,
    "completed",
    "Claim completed",
    "Fees have been claimed and the position is settled.",
    "wait",
  );

  return buildResponse(completedPosition, completedSession, await activityService.list(input.positionId), recoveryService);
}

async function withdrawClosePosition(
  positionRepo: PositionRepository,
  activityService: ActivityService,
  privacyAdapter: PrivacyAdapter,
  meteoraExecutor: MeteoraExecutor,
  input: WithdrawClosePositionInput,
): Promise<PositionResponse> {
  const recoveryService = createRecoveryService();
  const position = await getActivePosition(positionRepo, input.positionId);
  const session = await getLatestActiveSession(positionRepo, input.positionId);

  const executionMode = recoveryService.resolveExecutionMode({
    selectedMode: position.mode as ExecutionMode,
    surfacedFallback: false,
  }).mode;

  assertTransition(session.state as ExecutionState, "withdrawing");
  const withdrawingPosition = await positionRepo.updatePositionState(position.id, "withdrawing");
  const withdrawingSession = await positionRepo.updateExecutionSession(input.positionId, "withdrawing");
  await activityService.record(
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
    return recordFailure(positionRepo, activityService, recoveryService, position, "venue-submission", error);
  }

  let venueReceipt;
  try {
    venueReceipt = await meteoraExecutor.withdrawClose({
      podId: exitReceipt.podId ?? position.id,
      positionId: position.id,
    });
  } catch (error) {
    return recordFailure(positionRepo, activityService, recoveryService, position, "venue-confirmation", error);
  }

  assertTransition(withdrawingSession.state as ExecutionState, "closing");
  const closingPosition = await positionRepo.updatePositionState(position.id, "closing");
  const closingSession = await positionRepo.updateExecutionSession(input.positionId, "closing");
  await activityService.record(
    closingPosition,
    "closing",
    "Closing position",
    `Meteora returned ${venueReceipt.signature}; Octora is finalizing the close and reconciling balances.`,
    "wait",
  );

  assertTransition(closingSession.state as ExecutionState, "indexing");
  const indexingPosition = await positionRepo.updatePositionState(position.id, "indexing");
  const indexingSession = await positionRepo.updateExecutionSession(input.positionId, "indexing");
  await activityService.record(
    indexingPosition,
    "indexing",
    "Reconciling exit",
    "Octora is checking the final position state before marking the exit complete.",
    "wait",
  );

  assertTransition(indexingSession.state as ExecutionState, "completed");
  const completedPosition = await positionRepo.updatePositionState(position.id, "completed");
  const completedSession = await positionRepo.updateExecutionSession(input.positionId, "completed");
  await activityService.record(
    completedPosition,
    "completed",
    "Withdraw-close completed",
    "Your position has been withdrawn and closed.",
    "wait",
  );

  return buildResponse(completedPosition, completedSession, await activityService.list(input.positionId), recoveryService);
}

async function getPosition(
  positionRepo: PositionRepository,
  activityService: ActivityService,
  positionIndexer: PositionIndexer,
  positionId: string,
): Promise<PositionResponse> {
  const position = await positionRepo.getPositionById(positionId);
  if (!position) {
    throw new PositionNotFoundError(positionId);
  }

  const session = await positionRepo.getLatestExecutionSession(positionId);
  if (!session) {
    throw new PositionNotFoundError(positionId);
  }

  let activities = await activityService.list(positionId);
  const recoveryService = createRecoveryService();

  if ((session.state as ExecutionState) === "indexing") {
    const reconciliation = await positionIndexer.reconcile(positionId);

    if (reconciliation.state === "active" && (position.state as ExecutionState) !== "active") {
      const activePosition = await positionRepo.updatePositionState(positionId, "active");
      const activeSession = await positionRepo.updateExecutionSession(positionId, "active");
      await activityService.record(
        activePosition,
        "active",
        "Position active",
        "The final snapshot is available and the position is now live.",
        "wait",
      );

      return buildResponse(activePosition, activeSession, await activityService.list(positionId), recoveryService);
    }

    if (activities.at(-1)?.headline !== "Execution delayed") {
      const indexingRecovery = recoveryService.getIndexingRecovery();
      await activityService.record(
        position,
        "indexing",
        "Execution delayed",
        indexingRecovery.message,
        indexingRecovery.safeNextStep,
      );
      activities = await activityService.list(positionId);
    }
  }

  return buildResponse(position, session, activities, recoveryService);
}

function assertTransition(from: ExecutionState, to: ExecutionState) {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition from ${from} to ${to}`);
  }
}

async function getActivePosition(positionRepo: PositionRepository, positionId: string) {
  const position = await positionRepo.getPositionById(positionId);
  if (!position) {
    throw new PositionNotFoundError(positionId);
  }

  if ((position.state as ExecutionState) !== "active") {
    throw new Error(`Position ${positionId} must be active before this action can run`);
  }

  return position;
}

async function getLatestActiveSession(positionRepo: PositionRepository, positionId: string) {
  const session = await positionRepo.getLatestExecutionSession(positionId);
  if (!session) {
    throw new PositionNotFoundError(positionId);
  }

  if ((session.state as ExecutionState) !== "active") {
    throw new Error(`Execution session for ${positionId} must be active before this action can run`);
  }

  return session;
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
      recovery: resolveActivityRecovery(item, session.failureStage, mode, recoveryService, latestActivity?.id === item.id),
      createdAtIso: item.createdAt.toISOString(),
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
  positionRepo: PositionRepository,
  activityService: ActivityService,
  recoveryService: ReturnType<typeof createRecoveryService>,
  position: PositionRow,
  failureStage: RecoveryServiceInput["failureStage"],
  error: unknown,
) {
  const guidance = recoveryService.getRecoveryGuidance({ failureStage, mode: position.mode as ExecutionMode }) ?? recoveryService.getRecoveryGuidance({ failureStage: "recovery-required", mode: position.mode as ExecutionMode });
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
