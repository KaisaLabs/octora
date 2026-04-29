import { randomUUID } from "node:crypto";

import { modePolicy, type ActivityRecord, type ExecutionMode, type PositionAction, type PositionIntent } from "@octora/domain";

import type { ActivityRow, ExecutionSessionRow, OrchestratorDb, PositionRow } from "../db";

export interface CreateDraftPositionIntentInput {
  action: PositionAction;
  amount: string;
  pool: string;
  mode: ExecutionMode;
}

export interface PositionSessionState {
  id: string;
  positionId: string;
  state: "awaiting_signature" | "funding_in_progress" | "executing_on_meteora" | "indexing" | "active" | "claiming" | "withdrawing" | "closing" | "completed" | "failed";
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
  state: "draft" | "awaiting_signature" | "funding_in_progress" | "executing_on_meteora" | "indexing" | "active" | "claiming" | "withdrawing" | "closing" | "completed" | "failed";
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
}

export class PositionNotFoundError extends Error {
  constructor(positionId: string) {
    super(`Position ${positionId} not found`);
    this.name = "PositionNotFoundError";
  }
}

export function createOrchestratorService(db: OrchestratorDb) {
  return {
    createDraftPositionIntent(input: CreateDraftPositionIntentInput): Promise<PositionResponse> {
      return createDraftPositionIntent(db, input);
    },
    getPosition(positionId: string): Promise<PositionResponse> {
      return getPosition(db, positionId);
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

export async function getPosition(db: OrchestratorDb, positionId: string): Promise<PositionResponse> {
  const position = await db.getPositionById(positionId);
  if (!position) {
    throw new PositionNotFoundError(positionId);
  }

  const session = await db.getLatestExecutionSession(positionId);
  if (!session) {
    throw new PositionNotFoundError(positionId);
  }

  const activities = await db.listActivities(positionId);

  return buildResponse(position, session, activities);
}

function buildResponse(position: PositionRow, session: ExecutionSessionRow, activities: ActivityRow[]): PositionResponse {
  const modeLabel = modePolicy[position.mode as ExecutionMode]?.label ?? position.mode;
  const state = position.state as PositionSnapshot["state"];

  return {
    intent: {
      id: position.intentId,
      positionId: position.id,
      action: position.action as PositionAction,
      mode: position.mode as ExecutionMode,
      state: "draft",
      createdAtIso: position.createdAt.toISOString(),
    },
    position: {
      id: position.id,
      intentId: position.intentId,
      action: position.action as PositionAction,
      mode: position.mode as ExecutionMode,
      modeLabel,
      state,
      statusLabel: formatStatusLabel(position.state),
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
      state: session.state as PositionSessionState["state"],
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
    })),
  };
}

function formatPoolLabel(poolSlug: string) {
  if (poolSlug === "sol-usdc") return "SOL / USDC";
  return poolSlug.toUpperCase();
}

function formatAmount(amount: string) {
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? `${parsed.toFixed(2).replace(/\.00$/, ".00")} SOL` : amount;
}

function formatStatusLabel(state: string) {
  if (state === "draft") return "Awaiting signature";
  if (state === "awaiting_signature") return "Waiting for signature";
  if (state === "active") return "Active";
  if (state === "failed") return "Needs attention";
  return "In progress";
}
