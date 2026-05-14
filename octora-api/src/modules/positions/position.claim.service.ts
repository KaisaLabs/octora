/**
 * Claim & withdraw-close stages of the position lifecycle. Both start from
 * an `active` position; claim leaves the position open and collects fees,
 * withdraw-close fully exits.
 */
import type { ExecutionMode } from "#domain";
import type { PrivacyAdapter } from "#modules/execution/adapters";
import type { MeteoraExecutor } from "#modules/execution/clients";

import type { PositionRepository } from "./position.repository";
import type { ActivityService } from "./activity.service";
import { createRecoveryService } from "./recovery.service";
import {
  Position,
  type PositionAggregateDeps,
  type PositionResponse,
} from "./position.aggregate";

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
  const deps: PositionAggregateDeps = { positionRepo, activityService, recoveryService };
  const position = await Position.loadActive(deps, input.positionId);

  const executionMode = recoveryService.resolveExecutionMode({
    selectedMode: position.mode as ExecutionMode,
    surfacedFallback: false,
  }).mode;

  await position.advance("claiming", {
    headline: "Claiming fees",
    detail: "Octora is claiming the available fees and keeping the position flow private.",
    safeNextStep: "wait",
  });

  let exitReceipt;
  try {
    exitReceipt = await privacyAdapter.prepareExit({
      positionId: position.id,
      intentId: position.row.intentId,
      mode: executionMode,
    });
  } catch (error) {
    return position.recordFailure("venue-submission", error);
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
    return position.recordFailure("venue-confirmation", error);
  }

  await position.advance("indexing", {
    headline: "Reconciling claim",
    detail: `Meteora returned ${venueReceipt.signature}; Octora is reconciling the claim before finishing the flow.`,
    safeNextStep: "wait",
  });
  await position.advance("completed", {
    headline: "Claim completed",
    detail: "Fees have been claimed and the position is settled.",
    safeNextStep: "wait",
  });

  return position.toResponse();
}

export async function withdrawClosePosition(
  positionRepo: PositionRepository,
  activityService: ActivityService,
  privacyAdapter: PrivacyAdapter,
  meteoraExecutor: MeteoraExecutor,
  input: WithdrawClosePositionInput,
): Promise<PositionResponse> {
  const recoveryService = createRecoveryService();
  const deps: PositionAggregateDeps = { positionRepo, activityService, recoveryService };
  const position = await Position.loadActive(deps, input.positionId);

  const executionMode = recoveryService.resolveExecutionMode({
    selectedMode: position.mode as ExecutionMode,
    surfacedFallback: false,
  }).mode;

  await position.advance("withdrawing", {
    headline: "Withdrawing liquidity",
    detail: "Octora is removing the position through the private execution boundary.",
    safeNextStep: "wait",
  });

  let exitReceipt;
  try {
    exitReceipt = await privacyAdapter.prepareExit({
      positionId: position.id,
      intentId: position.row.intentId,
      mode: executionMode,
    });
  } catch (error) {
    return position.recordFailure("venue-submission", error);
  }

  let venueReceipt;
  try {
    venueReceipt = await meteoraExecutor.withdrawClose({
      podId: exitReceipt.podId ?? position.id,
      positionId: position.id,
    });
  } catch (error) {
    return position.recordFailure("venue-confirmation", error);
  }

  await position.advance("closing", {
    headline: "Closing position",
    detail: `Meteora returned ${venueReceipt.signature}; Octora is finalizing the close and reconciling balances.`,
    safeNextStep: "wait",
  });
  await position.advance("indexing", {
    headline: "Reconciling exit",
    detail: "Octora is checking the final position state before marking the exit complete.",
    safeNextStep: "wait",
  });
  await position.advance("completed", {
    headline: "Withdraw-close completed",
    detail: "Your position has been withdrawn and closed.",
    safeNextStep: "wait",
  });

  return position.toResponse();
}
