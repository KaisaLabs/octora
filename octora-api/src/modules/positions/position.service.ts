/**
 * Position service composition root.
 *
 * Delegates each lifecycle stage to a focused sibling service:
 *   - `position.intent.service`     — draft + read
 *   - `position.execution.service`  — signed → indexing
 *   - `position.claim.service`      — active → completed (claim / withdraw)
 *
 * Shared helpers live in `position.shared` so the lifecycle files stay
 * concerned with one stage each.
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
import { BetaCapExceededError, DEFAULT_BETA_CAPS, type PositionResponse } from "./position.shared";

export { BetaCapExceededError, PositionNotFoundError, UnsupportedPositionActionError };
export type { PositionResponse };
export type { CreateDraftPositionIntentInput, ExecuteSignedIntentInput, ClaimPositionInput, WithdrawClosePositionInput };
export type {
  PositionSessionState,
  PositionSnapshot,
} from "./position.shared";

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

  return {
    createDraftPositionIntent(input: CreateDraftPositionIntentInput): Promise<PositionResponse> {
      return createDraftPositionIntent(positionRepo, activityService, betaCaps, input);
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
    getPosition(positionId: string): Promise<PositionResponse> {
      return getPosition(positionRepo, activityService, positionIndexer, positionId);
    },
  };
}
