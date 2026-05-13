/**
 * Execution stage of the position lifecycle: turn a signed intent into a
 * prepared execution pod, then hand off to the indexer for active-state
 * reconciliation.
 */
import type { ExecutionMode, ExecutionState, PositionAction } from "#domain";
import { PositionNotFoundError, UnsupportedPositionActionError } from "#common/errors";
import type { PrivacyAdapter } from "#modules/execution/adapters";
import type { MeteoraExecutor } from "#modules/execution/clients";
import type { PositionIndexer } from "#modules/indexer";

import type { PositionRepository } from "./position.repository";
import type { ActivityService } from "./activity.service";
import type { createRecoveryService } from "./recovery.service";

import {
  assertTransition,
  buildResponse,
  formatAmount,
  recordFailure,
  type PositionResponse,
} from "./position.shared";

export interface ExecuteSignedIntentInput {
  positionId: string;
  signedMessage: string;
}

export async function executeSignedIntent(
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
  await activityService.record(
    position,
    "funding_in_progress",
    "Funding started",
    `Routing ${formatAmount(position.amount)} into the execution boundary.`,
    "wait",
  );

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
