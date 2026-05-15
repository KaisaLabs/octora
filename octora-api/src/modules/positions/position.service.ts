/**
 * Position service composition root.
 *
 * Delegates each lifecycle stage to a focused sibling service:
 *   - `position.intent.service`     — draft + read
 *   - `position.execution.service`  — signed → indexing
 *   - `position.claim.service`      — active → completed (claim / withdraw)
 *
 * Shared aggregate (state transitions + failure recording + response
 * shape) lives in `position.aggregate`; the lifecycle files use it
 * directly so each stays focused on one stage.
 */
import { MockPrivacyAdapter, type PrivacyAdapter } from "#modules/execution/adapters";
import { createMockMeteoraExecutor, type MeteoraExecutor } from "#modules/execution/clients";
import { createIndexerService, type PositionIndexer } from "#modules/indexer";
import type { ReconciliationRepository } from "#modules/indexer/indexer.repository";
import { PositionNotFoundError, UnsupportedPositionActionError } from "#common/errors";
import type { BetaCapsConfig } from "#common/config";

import type { PositionRepository } from "./position.repository";
import type { ActivityRepository } from "./activity.repository";
import { createActivityService } from "./activity.service";
import { createRecoveryService } from "./recovery.service";
import {
  createDraftPositionIntent,
  getPosition,
  type CreateDraftPositionIntentInput,
} from "./position.intent.service";
import {
  executeSignedIntent,
  type ExecuteSignedIntentInput,
} from "./position.execution.service";
import {
  claimPosition,
  withdrawClosePosition,
  type ClaimPositionInput,
  type WithdrawClosePositionInput,
} from "./position.claim.service";
import {
  createDepositLpService,
  type RecordDepositInput,
  DepositLpStateTransitionError,
} from "./position.deposit-lp.service";
import {
  InvalidRecoveryStateError,
  recoverFundsUserSigned,
  type RecoverFundsUserSignedInput,
} from "./position.recover.service";
import {
  claimMidPositionFees,
  remixClaimedFees,
  MidPositionFeeClaimStateError,
  FeeClaimBelowThresholdError,
  type ClaimMidPositionFeesInput,
  type ClaimMidPositionFeesResult,
  type RemixClaimedFeesInput,
  type RemixClaimedFeesResult,
} from "./position.fee-claim.service";
import {
  BetaCapExceededError,
  DEFAULT_BETA_CAPS,
  type PositionResponse,
} from "./position.aggregate";

export {
  BetaCapExceededError,
  PositionNotFoundError,
  UnsupportedPositionActionError,
  DepositLpStateTransitionError,
  InvalidRecoveryStateError,
  MidPositionFeeClaimStateError,
  FeeClaimBelowThresholdError,
};
export type { PositionResponse };
export type {
  CreateDraftPositionIntentInput,
  ExecuteSignedIntentInput,
  ClaimPositionInput,
  WithdrawClosePositionInput,
  RecordDepositInput,
  RecoverFundsUserSignedInput,
  ClaimMidPositionFeesInput,
  ClaimMidPositionFeesResult,
  RemixClaimedFeesInput,
  RemixClaimedFeesResult,
};
export type {
  PositionSessionState,
  PositionSnapshot,
} from "./position.aggregate";

export interface PositionServiceDependencies {
  positionRepo: PositionRepository;
  activityRepo: ActivityRepository;
  reconciliationRepo?: ReconciliationRepository;
  privacyAdapter?: PrivacyAdapter;
  meteoraExecutor?: MeteoraExecutor;
  positionIndexer?: PositionIndexer;
  recoveryService?: ReturnType<typeof createRecoveryService>;
  /**
   * Beta cohort caps. Defaults to {@link DEFAULT_BETA_CAPS} so existing
   * tests that don't care about caps don't have to pass a config.
   */
  betaCaps?: BetaCapsConfig;
}

export function createPositionService(deps: PositionServiceDependencies) {
  const positionRepo = deps.positionRepo;
  const activityRepo = deps.activityRepo;
  const activityService = createActivityService(activityRepo);
  const privacyAdapter = deps.privacyAdapter ?? new MockPrivacyAdapter();
  const meteoraExecutor = deps.meteoraExecutor ?? createMockMeteoraExecutor();
  const positionIndexer =
    deps.positionIndexer ?? createIndexerService({ store: deps.reconciliationRepo! });
  const recoveryService = deps.recoveryService ?? createRecoveryService();
  const betaCaps = deps.betaCaps ?? DEFAULT_BETA_CAPS;
  const depositLp = createDepositLpService({ positionRepo, activityService });

  return {
    createDraftPositionIntent(input: CreateDraftPositionIntentInput): Promise<PositionResponse> {
      return createDraftPositionIntent(positionRepo, activityService, betaCaps, input);
    },
    // ── Deposit LP Fallback state-machine driver ──────────────────────
    // Each method transitions the Position through a single Deposit LP
    // Fallback sub-state. The aggregate's `advance` validates against
    // `transitions[]` in execution-state-machine.ts, so an illegal jump
    // (e.g. `DEPOSITED -> LP_DONE` skipping `LP_PENDING`) surfaces as a
    // `DepositLpStateTransitionError` instead of corrupting state.
    recordDeposit(input: RecordDepositInput): Promise<PositionResponse> {
      return depositLp.recordDeposit(input);
    },
    markLpPending(positionId: string): Promise<PositionResponse> {
      return depositLp.markLpPending(positionId);
    },
    markLpDone(positionId: string): Promise<PositionResponse> {
      return depositLp.markLpDone(positionId);
    },
    markLpFailed(positionId: string, reason: string): Promise<PositionResponse> {
      return depositLp.markLpFailed(positionId, reason);
    },
    retryLp(positionId: string): Promise<PositionResponse> {
      return depositLp.retryLp(positionId);
    },
    parkLp(positionId: string): Promise<PositionResponse> {
      return depositLp.parkLp(positionId);
    },
    markWithdrawn(positionId: string): Promise<PositionResponse> {
      return depositLp.markWithdrawn(positionId);
    },
    /**
     * dust/04 entry point — the user broke the relayer-offline glass,
     * signed `mixer.withdraw` themselves, broadcast it directly to RPC,
     * and is now reporting the on-chain outcome so the orchestration
     * state matches. Throws `InvalidRecoveryStateError` when the
     * Position is not in `LP_FAILED` or `PARKED`. See
     * `position.recover.service` for the privacy + ADR-0002/0004
     * rationale.
     */
    recoverFundsUserSigned(input: RecoverFundsUserSignedInput): Promise<PositionResponse> {
      return recoverFundsUserSigned(positionRepo, activityService, input);
    },
    executeSignedIntent(input: ExecuteSignedIntentInput): Promise<PositionResponse> {
      return executeSignedIntent(
        positionRepo,
        activityService,
        privacyAdapter,
        meteoraExecutor,
        positionIndexer,
        recoveryService,
        input,
      );
    },
    claimPosition(input: ClaimPositionInput): Promise<PositionResponse> {
      return claimPosition(positionRepo, activityService, privacyAdapter, meteoraExecutor, input);
    },
    withdrawClosePosition(input: WithdrawClosePositionInput): Promise<PositionResponse> {
      return withdrawClosePosition(positionRepo, activityService, privacyAdapter, meteoraExecutor, input);
    },
    /**
     * close/05 — mid-position fee claim. Builds + relayer-signs
     * `dlmm_claim_fees`, lands fees in the Stealth Wallet, emits an
     * Activity Record at `active`. Position state does NOT change.
     */
    claimMidPositionFees(input: ClaimMidPositionFeesInput): Promise<ClaimMidPositionFeesResult> {
      return claimMidPositionFees(positionRepo, activityService, meteoraExecutor, input);
    },
    /**
     * close/05 — re-mix the claimed SOL. Wraps the existing Flow 1
     * `mixer.deposit` machinery and tags the Activity Record with
     * `source: "fee-claim"`. The deposit ix is built via the existing
     * /mixer/deposit endpoint; this endpoint records the outcome so
     * the audit trail links the claim → re-mix → fresh Commitment.
     */
    remixClaimedFees(input: RemixClaimedFeesInput): Promise<RemixClaimedFeesResult> {
      return remixClaimedFees(positionRepo, activityService, input);
    },
    getPosition(positionId: string): Promise<PositionResponse> {
      return getPosition(positionRepo, activityService, positionIndexer, positionId);
    },
  };
}
