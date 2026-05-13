/**
 * Claim & withdraw-close stages of the position lifecycle. Both start from
 * an `active` position; claim leaves the position open and collects fees,
 * withdraw-close fully exits.
 */
import type { ExecutionMode, ExecutionState } from "#domain";
import type { PrivacyAdapter } from "#modules/execution/adapters";
import type { MeteoraExecutor } from "#modules/execution/clients";

import type { PositionRepository } from "./position.repository";
import type { ActivityService } from "./activity.service";
import { createRecoveryService } from "./recovery.service";

import {
  assertTransition,
  buildResponse,
  getActivePosition,
  getLatestActiveSession,
  recordFailure,
  type PositionResponse,
} from "./position.shared";

export interface ClaimPositionInput {
  positionId: string;
}

export interface WithdrawClosePositionInput {
  positionId: string;
}

export async function claimPosition(
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

  // MAINNET_BLOCKER: this lifecycle path goes through `meteoraExecutor` from
  // execution/clients/executor.factory.ts, which returns the mock unless
  // OCTORA_USE_ONCHAIN_EXECUTOR=true *and* the OnchainMeteoraExecutor's
  // ClaimInput is widened to carry the OnchainPositionContext (stealth
  // keypair + 14-account remaining_accounts). The pool-detail UI bypasses
  // this entirely via /executor/claim-fees-tx so it works today; this
  // managed lifecycle still records "claimed" with a fake signature.
  // See docs/test-plan.md §14.
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

export async function withdrawClosePosition(
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
