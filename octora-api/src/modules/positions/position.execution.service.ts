/**
 * Execution stage of the position lifecycle: turn a signed intent into a
 * prepared execution pod, then hand off to the indexer for active-state
 * reconciliation.
 */
import type { ExecutionMode, PositionAction } from "#domain";
import { UnsupportedPositionActionError } from "#common/errors";
import type { PrivacyAdapter } from "#modules/execution/adapters";
import type { MeteoraExecutor } from "#modules/execution/clients";
import type { PositionIndexer } from "#modules/indexer";

import type { PositionRepository } from "./position.repository";
import type { ActivityService } from "./activity.service";
import {
  Position,
  formatAmount,
  type PositionAggregateDeps,
  type PositionResponse,
  type RecoveryService,
} from "./position.aggregate";

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
  recoveryService: RecoveryService,
  input: ExecuteSignedIntentInput,
): Promise<PositionResponse> {
  if (!input.signedMessage.length) {
    throw new Error("Signed message is required");
  }

  const deps: PositionAggregateDeps = { positionRepo, activityService, recoveryService };
  const position = await Position.load(deps, input.positionId);

  if (position.action !== "add-liquidity") {
    throw new UnsupportedPositionActionError(position.action as PositionAction);
  }

  const executionMode = recoveryService.resolveExecutionMode({
    selectedMode: position.mode as ExecutionMode,
    surfacedFallback: false,
  }).mode;

  await position.advanceSessionOnly("funding_in_progress", {
    headline: "Funding started",
    detail: `Routing ${formatAmount(position.row.amount)} into the execution boundary.`,
    safeNextStep: "wait",
  });

  let fundingReceipt;
  try {
    fundingReceipt = await privacyAdapter.prepareFunding({
      positionId: position.id,
      intentId: position.row.intentId,
      poolSlug: position.row.poolSlug,
      amount: position.row.amount,
      mode: executionMode,
    });
  } catch (error) {
    return position.recordFailure("pre-funding", error);
  }

  await position.advanceSessionOnly("executing_on_meteora", {
    headline: "Submitting to Meteora",
    detail: `Prepared the execution pod ${fundingReceipt.podId ?? "unknown"} for onchain submission.`,
    safeNextStep: "wait",
  });

  let venueReceipt;
  try {
    venueReceipt = await meteoraExecutor.addLiquidity({
      podId: fundingReceipt.podId ?? position.id,
      amountSol: position.row.amount,
    });
  } catch (error) {
    return position.recordFailure("funding-partial", error);
  }

  positionIndexer.beginReconciliation({ positionId: position.id });
  await position.advance("indexing", {
    headline: "Verifying final position state",
    detail: `Meteora returned ${venueReceipt.signature}; Octora is checking the final position state before activating it.`,
    safeNextStep: "wait",
  });
  positionIndexer.registerSnapshot({ positionId: position.id, signature: venueReceipt.signature });

  return position.toResponse();
}
