/**
 * Intent stage of the position lifecycle: create a draft, run the beta-cap
 * preflight, return a draft session waiting for signature. Also hosts the
 * read-side `getPosition` and the indexer-driven advance to `active`.
 */
import { randomUUID } from "node:crypto";

import type { ExecutionMode, ExecutionState, PositionAction } from "#domain";
import type { PositionIndexer } from "#modules/indexer";
import type { BetaCapsConfig } from "#common/config";
import { PositionNotFoundError } from "#common/errors";

import type { PositionRepository } from "./position.repository";
import type { ActivityService } from "./activity.service";
import { createRecoveryService } from "./recovery.service";
import {
  BetaCapExceededError,
  buildResponse,
  formatPoolLabel,
  type PositionResponse,
} from "./position.shared";

export interface CreateDraftPositionIntentInput {
  action: PositionAction;
  amount: string;
  pool: string;
  mode: ExecutionMode;
  /** Authenticated wallet from `requireWalletSignature`. Required. */
  walletAddress: string;
}

export async function createDraftPositionIntent(
  positionRepo: PositionRepository,
  activityService: ActivityService,
  betaCaps: BetaCapsConfig,
  input: CreateDraftPositionIntentInput,
): Promise<PositionResponse> {
  if (!input.walletAddress) {
    throw new Error("walletAddress is required to create a position intent");
  }

  await assertBetaCaps(positionRepo, betaCaps, input);

  const positionId = randomUUID();
  const intentId = randomUUID();
  const sessionId = randomUUID();

  const position = await positionRepo.createPosition({
    id: positionId,
    intentId,
    walletAddress: input.walletAddress,
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

export async function getPosition(
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

/**
 * Beta-cohort guardrails enforced at intent creation. All caps are SOL,
 * not USD — the API doesn't have a price feed wired in for this path, so
 * operators set lamports-equivalent SOL ceilings via `BETA_MAX_*` env vars
 * (see common/config.ts). The audit (P1-26) targets ~$500 / ~$25k / 5
 * active positions per wallet.
 */
async function assertBetaCaps(
  positionRepo: PositionRepository,
  caps: BetaCapsConfig,
  input: CreateDraftPositionIntentInput,
): Promise<void> {
  const amountSol = Number(input.amount);
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    throw new BetaCapExceededError(
      `amount must be a positive decimal SOL value; got "${input.amount}".`,
    );
  }
  if (amountSol > caps.maxPositionSol) {
    throw new BetaCapExceededError(
      `Per-position cap exceeded: ${amountSol} SOL > ${caps.maxPositionSol} SOL.`,
    );
  }

  const [walletCount, globalTvl] = await Promise.all([
    positionRepo.countActiveByWallet(input.walletAddress),
    positionRepo.sumActiveAmountSol(),
  ]);

  if (walletCount >= caps.maxPositionsPerWallet) {
    throw new BetaCapExceededError(
      `Per-wallet position cap exceeded: wallet already has ${walletCount} active positions ` +
        `(cap ${caps.maxPositionsPerWallet}).`,
    );
  }

  if (globalTvl + amountSol > caps.maxGlobalTvlSol) {
    throw new BetaCapExceededError(
      `Global beta TVL cap exceeded: existing ${globalTvl.toFixed(3)} + new ${amountSol} SOL ` +
        `would surpass ${caps.maxGlobalTvlSol} SOL.`,
    );
  }
}
