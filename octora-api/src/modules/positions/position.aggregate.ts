/**
 * Position aggregate. Wraps `(PositionRow, ExecutionSessionRow,
 * activity log)` behind a small set of methods so the three lifecycle
 * services (intent / execution / claim) stop threading
 * `(positionRepo, activityService, recoveryService, positionRow,
 *  sessionRow)` through every stage.
 *
 * Previous shape: `position.shared.ts` exposed five free helpers
 * (`assertTransition`, `getActivePosition`, `getLatestActiveSession`,
 * `buildResponse`, `recordFailure`) that each lifecycle file imported
 * and re-plumbed by hand. The deletion test on `shared.ts` ("if we
 * delete it, where does the complexity go?") says it goes back into
 * three call sites identically — earning its keep as a *passive
 * helper bag*, not as a real abstraction. This file finishes the
 * extraction: invariants (transitions, failure recording, response
 * shape) live with the data they constrain.
 *
 * Aggregate boundaries:
 *   - Owns its `PositionRow` + `ExecutionSessionRow`. Replaces them
 *     after each mutation; callers read the latest via `row` / `session`.
 *   - Doesn't own external adapter calls (privacy, meteora, indexer).
 *     The lifecycle services still drive those — they interleave
 *     external calls with aggregate transitions.
 *   - Doesn't own indexer reconciliation. `getPosition` still does
 *     that inline; folding it in here would couple the aggregate to
 *     `PositionIndexer`, and only one caller needs it.
 */
import { randomUUID } from "node:crypto";

import {
  canTransition,
  isTerminalDepositLpState,
  modePolicy,
  type ActivityRecord,
  type ExecutionMode,
  type ExecutionState,
  type FailureStage,
  type PositionAction,
  type PositionIntent,
  type RecoveryGuidance,
} from "#domain";
import { PositionNotFoundError, RateLimitedError } from "#common/errors";
import type { BetaCapsConfig } from "#common/config";

import type {
  ExecutionSessionRow,
  PositionRepository,
  PositionRow,
} from "./position.repository";
import type { ActivityRow } from "./activity.repository";
import type { ActivityService } from "./activity.service";
import { createRecoveryService, type RecoveryServiceInput } from "./recovery.service";

export type RecoveryService = ReturnType<typeof createRecoveryService>;

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

export interface PositionAggregateDeps {
  positionRepo: PositionRepository;
  activityService: ActivityService;
  recoveryService: RecoveryService;
}

export interface ActivityWrite {
  headline: string;
  detail: string;
  safeNextStep: ActivityRecord["safeNextStep"];
}

export interface CreatePositionInput {
  positionId?: string;
  intentId?: string;
  sessionId?: string;
  walletAddress: string;
  action: PositionAction;
  mode: ExecutionMode;
  poolSlug: string;
  amount: string;
  /**
   * First activity row. Recorded at `awaiting_signature` (matches the
   * session's initial state) — the position row sits at `draft` until
   * the user signs and execution begins.
   */
  firstActivity: ActivityWrite;
}

export class Position {
  private constructor(
    private readonly deps: PositionAggregateDeps,
    private positionRow: PositionRow,
    private sessionRow: ExecutionSessionRow,
  ) {}

  // ── Factories ──────────────────────────────────────────────────────

  /**
   * Create a brand-new draft position + execution session + first
   * activity in one shot. Returns the aggregate ready to be returned
   * from `createDraftPositionIntent`.
   */
  static async create(
    deps: PositionAggregateDeps,
    input: CreatePositionInput,
  ): Promise<Position> {
    const positionId = input.positionId ?? randomUUID();
    const intentId = input.intentId ?? randomUUID();
    const sessionId = input.sessionId ?? randomUUID();

    const positionRow = await deps.positionRepo.createPosition({
      id: positionId,
      intentId,
      walletAddress: input.walletAddress,
      action: input.action,
      mode: input.mode,
      state: "draft",
      poolSlug: input.poolSlug,
      amount: input.amount,
    });
    const sessionRow = await deps.positionRepo.createExecutionSession({
      id: sessionId,
      positionId,
      state: "awaiting_signature",
      failureStage: null,
    });
    const aggregate = new Position(deps, positionRow, sessionRow);
    await aggregate.recordActivity("awaiting_signature", input.firstActivity);
    return aggregate;
  }

  /**
   * Load an existing aggregate by id. Throws `PositionNotFoundError`
   * if either the position or its latest session is missing.
   */
  static async load(deps: PositionAggregateDeps, positionId: string): Promise<Position> {
    const positionRow = await deps.positionRepo.getPositionById(positionId);
    if (!positionRow) throw new PositionNotFoundError(positionId);
    const sessionRow = await deps.positionRepo.getLatestExecutionSession(positionId);
    if (!sessionRow) throw new PositionNotFoundError(positionId);
    return new Position(deps, positionRow, sessionRow);
  }

  /**
   * Load an aggregate and assert it is in the `active` resting state on
   * both the position row and its latest session. Used by claim /
   * withdraw entry points where any other state is a programmer error.
   */
  static async loadActive(deps: PositionAggregateDeps, positionId: string): Promise<Position> {
    const aggregate = await Position.load(deps, positionId);
    if (aggregate.state !== "active") {
      throw new Error(`Position ${positionId} must be active before this action can run`);
    }
    if (aggregate.sessionState !== "active") {
      throw new Error(
        `Execution session for ${positionId} must be active before this action can run`,
      );
    }
    return aggregate;
  }

  // ── Read accessors ─────────────────────────────────────────────────

  get row(): PositionRow {
    return this.positionRow;
  }
  get session(): ExecutionSessionRow {
    return this.sessionRow;
  }
  get id(): string {
    return this.positionRow.id;
  }
  get state(): ExecutionState {
    return this.positionRow.state as ExecutionState;
  }
  get sessionState(): ExecutionState {
    return this.sessionRow.state as ExecutionState;
  }
  get mode(): ExecutionMode {
    return this.positionRow.mode as ExecutionMode;
  }
  get action(): PositionAction {
    return this.positionRow.action as PositionAction;
  }

  // ── Mutations ──────────────────────────────────────────────────────

  /**
   * Advance both the position row and the execution session to
   * `target`, then record an activity row at `target`. Used at every
   * "joint progression" point (`indexing`, `active`, `claiming`,
   * `withdrawing`, `closing`, `completed`).
   */
  async advance(target: ExecutionState, activity: ActivityWrite): Promise<void> {
    if (!canTransition(this.sessionState, target)) {
      throw new Error(`Invalid state transition from ${this.sessionState} to ${target}`);
    }
    this.positionRow = await this.deps.positionRepo.updatePositionState(this.positionRow.id, target);
    this.sessionRow = await this.deps.positionRepo.updateExecutionSession(this.positionRow.id, target);
    if (isTerminalDepositLpState(target)) {
      await this.deps.positionRepo.clearDepositIntentForPosition(this.positionRow.id);
    }
    await this.recordActivity(target, activity);
  }

  /**
   * Advance only the execution session — the position row stays at
   * its current resting state. Used for the intermediate execution
   * stages (`funding_in_progress`, `executing_on_meteora`) where the
   * position is still effectively "draft" from the user's POV until
   * the venue submission lands.
   */
  async advanceSessionOnly(target: ExecutionState, activity: ActivityWrite): Promise<void> {
    if (!canTransition(this.sessionState, target)) {
      throw new Error(`Invalid state transition from ${this.sessionState} to ${target}`);
    }
    this.sessionRow = await this.deps.positionRepo.updateExecutionSession(this.positionRow.id, target);
    await this.recordActivity(target, activity);
  }

  /**
   * Record an activity row at `state` without changing any aggregate
   * state. Used by the indexer-driven `getPosition` path to surface an
   * "Execution delayed" notice while staying in `indexing`.
   */
  async recordActivity(state: ExecutionState, activity: ActivityWrite): Promise<void> {
    await this.deps.activityService.record(
      this.positionRow,
      state,
      activity.headline,
      activity.detail,
      activity.safeNextStep,
    );
  }

  /**
   * Drive the aggregate to `failed` with a `failureStage` stamped on the
   * session, record a failure activity with recovery guidance, and
   * return a full response. Mirrors the old `recordFailure` helper.
   */
  async recordFailure(stage: FailureStage, error: unknown): Promise<PositionResponse> {
    const guidance =
      this.deps.recoveryService.getRecoveryGuidance({
        failureStage: stage,
        mode: this.mode,
      }) ??
      this.deps.recoveryService.getRecoveryGuidance({
        failureStage: "recovery-required",
        mode: this.mode,
      });

    if (
      this.mode === "fast-private" &&
      guidance?.fallbackMode === "standard" &&
      guidance.surfaceDowngradeDisclosure
    ) {
      this.positionRow = await this.deps.positionRepo.updatePositionMode(this.positionRow.id, "standard");
    }

    this.positionRow = await this.deps.positionRepo.updatePositionState(this.positionRow.id, "failed");
    this.sessionRow = await this.deps.positionRepo.updateExecutionSession(
      this.positionRow.id,
      "failed",
      stage,
    );

    await this.recordActivity("failed", {
      headline: guidance?.headline ?? "Needs attention",
      detail: guidance?.message ?? formatFailureMessage(error),
      safeNextStep: guidance?.safeNextStep ?? "contact-support",
    });

    return this.toResponse();
  }

  // ── Read API ───────────────────────────────────────────────────────

  /** Fetch the current activity log and return the API response shape. */
  async toResponse(): Promise<PositionResponse> {
    const activities = await this.deps.activityService.list(this.positionRow.id);
    return buildResponse(this.positionRow, this.sessionRow, activities, this.deps.recoveryService);
  }
}

// ── Pure formatting helpers ──────────────────────────────────────────
// Kept module-level (not on the class) because they're pure and
// callers outside the aggregate sometimes want them on a poolSlug /
// amount that hasn't been wrapped in a Position yet.

export function formatPoolLabel(poolSlug: string): string {
  if (poolSlug === "sol-usdc") return "SOL / USDC";
  return poolSlug.toUpperCase();
}

export function formatAmount(amount: string): string {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return amount;
  return `${parsed.toFixed(2).replace(/\.00$/, ".00")} SOL`;
}

function formatStatusLabel(state: ExecutionState, latestHeadline?: string): string {
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
      return latestHeadline === "Execution delayed"
        ? "Execution delayed"
        : "Verifying final position state";
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
    case "DEPOSITED":
      return "Deposit confirmed";
    case "LP_PENDING":
      return "Adding liquidity";
    case "LP_FAILED":
      return "Add liquidity failed";
    case "LP_RETRIED":
      return "Retrying add liquidity";
    case "PARKED":
      return "Parked for later";
    case "WITHDRAWN":
      return "Recovered";
    case "LP_DONE":
      return "Position active";
    case "CLOSING":
      return "Closing position on Meteora";
    case "CLOSE_FAILED":
      return "Close failed";
    case "SWAPPING":
      return "Swapping to SOL";
    case "SWAP_FAILED":
      return "Swap failed";
    case "REMIXING":
      return "Re-mixing into anonymity set";
    case "REMIX_FAILED":
      return "Re-mix failed";
    case "CLOSED":
      return "Closed privately";
  }
}

function buildResponse(
  position: PositionRow,
  session: ExecutionSessionRow,
  activities: ActivityRow[],
  recoveryService: RecoveryService,
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
      recovery: resolveActivityRecovery(
        item,
        session.failureStage,
        mode,
        recoveryService,
        latestActivity?.id === item.id,
      ),
      createdAtIso: item.createdAt.toISOString(),
    })),
    recovery,
  };
}

function resolveRecovery(
  mode: ExecutionMode,
  failureStage: string | null,
  latestActivity: ActivityRow | undefined,
  recoveryService: RecoveryService,
): RecoveryGuidance | null {
  if (failureStage) {
    if (latestActivity?.headline === "Position downgraded to standard mode") {
      return recoveryService.getRecoveryGuidance({
        failureStage: failureStage as RecoveryServiceInput["failureStage"],
        mode: "fast-private",
      });
    }
    return recoveryService.getRecoveryGuidance({
      failureStage: failureStage as RecoveryServiceInput["failureStage"],
      mode,
    });
  }
  return resolveActivityRecovery(latestActivity, null, mode, recoveryService, true);
}

function resolveActivityRecovery(
  activity: ActivityRow | undefined,
  failureStage: string | null,
  mode: ExecutionMode,
  recoveryService: RecoveryService,
  isLatestActivity: boolean,
): RecoveryGuidance | null {
  if (failureStage && isLatestActivity) {
    if (activity?.headline === "Position downgraded to standard mode") {
      return recoveryService.getRecoveryGuidance({
        failureStage: failureStage as RecoveryServiceInput["failureStage"],
        mode: "fast-private",
      });
    }
    return recoveryService.getRecoveryGuidance({
      failureStage: failureStage as RecoveryServiceInput["failureStage"],
      mode,
    });
  }
  if (activity?.state === "indexing" && activity.headline === "Execution delayed") {
    return recoveryService.getIndexingRecovery();
  }
  if (activity?.state === "failed") {
    return recoveryService.getRecoveryGuidance({
      failureStage: "recovery-required",
      mode: "fast-private",
    });
  }
  return null;
}

function formatFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Octora stopped safely and needs another pass.";
}
