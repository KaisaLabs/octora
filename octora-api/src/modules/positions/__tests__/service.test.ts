import { beforeEach, describe, expect, it } from "vitest";

import { createMockMeteoraExecutor } from "#clients";
import { MockPrivacyAdapter } from "#adapters";

import type {
  ActivityRow,
  CreateActivityInput,
  CreatePositionInput,
  CreateSessionInput,
  ExecutionSessionRow,
  OrchestratorDb,
  PositionReconciliationRow,
  PositionRow,
} from "../../db";
import { createPositionService } from "../service";
import { createPositionIndexer } from "#indexer";

function createMemoryDb(): OrchestratorDb {
  const positions = new Map<string, PositionRow>();
  const sessions = new Map<string, ExecutionSessionRow[]>();
  const activities = new Map<string, ActivityRow[]>();
  const reconciliations = new Map<string, PositionReconciliationRow>();

  return {
    async createPosition(input: CreatePositionInput) {
      const now = new Date("2026-04-29T09:00:00.000Z");
      const row: PositionRow = {
        ...input,
        createdAt: now,
        updatedAt: now,
      };
      positions.set(row.id, row);
      return row;
    },
    async updatePositionState(positionId: string, state: string) {
      const current = positions.get(positionId);
      if (!current) {
        throw new Error(`Position ${positionId} not found`);
      }

      const row: PositionRow = {
        ...current,
        state,
        updatedAt: new Date("2026-04-29T09:00:00.000Z"),
      };
      positions.set(positionId, row);
      return row;
    },
    async getPositionById(positionId: string) {
      return positions.get(positionId) ?? null;
    },
    async createExecutionSession(input: CreateSessionInput) {
      const now = new Date("2026-04-29T09:00:00.000Z");
      const row: ExecutionSessionRow = {
        id: input.id,
        positionId: input.positionId,
        state: input.state,
        failureStage: input.failureStage ?? null,
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(input.positionId, [...(sessions.get(input.positionId) ?? []), row]);
      return row;
    },
    async updateExecutionSession(positionId: string, state: string, failureStage: string | null = null) {
      const items = sessions.get(positionId) ?? [];
      const current = items.at(-1);
      if (!current) {
        throw new Error(`Execution session for ${positionId} not found`);
      }

      const row: ExecutionSessionRow = {
        ...current,
        state,
        failureStage,
        updatedAt: new Date("2026-04-29T09:00:00.000Z"),
      };
      sessions.set(positionId, [...items.slice(0, -1), row]);
      return row;
    },
    async getLatestExecutionSession(positionId: string) {
      const items = sessions.get(positionId) ?? [];
      return items.at(-1) ?? null;
    },
    async createActivity(input: CreateActivityInput) {
      const row: ActivityRow = {
        ...input,
        createdAt: new Date("2026-04-29T09:00:00.000Z"),
      };
      activities.set(input.positionId, [...(activities.get(input.positionId) ?? []), row]);
      return row;
    },
    async listActivities(positionId: string) {
      return activities.get(positionId) ?? [];
    },
    async load(positionId: string) {
      return reconciliations.get(positionId) ?? null;
    },
    async save(input: { positionId: string; signature: string | null }) {
      const now = new Date("2026-04-29T09:00:00.000Z");
      const existing = reconciliations.get(input.positionId);
      const row: PositionReconciliationRow = {
        positionId: input.positionId,
        signature: input.signature,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      reconciliations.set(input.positionId, row);
      return row;
    },
    async clear(positionId: string) {
      reconciliations.delete(positionId);
    },
  };
}

describe("orchestrator service", () => {
  let db = createMemoryDb();

  beforeEach(() => {
    db = createMemoryDb();
  });

  it("holds a signed add-liquidity request in indexing until the snapshot is reconciled", async () => {
    const positionId = "pos_1";

    await db.createPosition({
      id: positionId,
      intentId: "intent_1",
      action: "add-liquidity",
      mode: "fast-private",
      state: "awaiting_signature",
      poolSlug: "sol-usdc",
      amount: "1.25",
    });
    await db.createExecutionSession({
      id: "session_1",
      positionId,
      state: "awaiting_signature",
      failureStage: null,
    });
    await db.createActivity({
      id: "activity_1",
      positionId,
      action: "add-liquidity",
      state: "awaiting_signature",
      headline: "Intent received",
      detail: "Queued a draft SOL / USDC position for signature review.",
      safeNextStep: "wait",
    });

    const service = createPositionService(db, {
      privacyAdapter: new MockPrivacyAdapter(),
      meteoraExecutor: createMockMeteoraExecutor(),
    });

    const result = await service.executeSignedIntent({
      positionId,
      signedMessage: "base64sig",
    });

    expect(result.position.state).toBe("indexing");
    expect(result.session.state).toBe("indexing");
    expect(result.position.statusLabel).toBe("Verifying final position state");
    expect(result.activity.map((item) => item.state)).toEqual([
      "awaiting_signature",
      "funding_in_progress",
      "executing_on_meteora",
      "indexing",
    ]);

    const reconciled = await service.getPosition(positionId);

    expect(reconciled.position.state).toBe("active");
    expect(reconciled.session.state).toBe("active");
    expect(reconciled.position.statusLabel).toBe("Position active");
  });

  it("surfaces indexing lag recovery guidance while the final snapshot is missing", async () => {
    const positionId = "pos_2";

    await db.createPosition({
      id: positionId,
      intentId: "intent_2",
      action: "add-liquidity",
      mode: "fast-private",
      state: "indexing",
      poolSlug: "sol-usdc",
      amount: "1.25",
    });
    await db.createExecutionSession({
      id: "session_2",
      positionId,
      state: "indexing",
      failureStage: null,
    });
    await db.createActivity({
      id: "activity_2",
      positionId,
      action: "add-liquidity",
      state: "indexing",
      headline: "Verifying final position state",
      detail: "Meteora returned signature-1; Octora is checking the final position state before activating it.",
      safeNextStep: "wait",
    });

    const service = createPositionService(db, {
      positionIndexer: {
        beginReconciliation: async () => ({ state: "indexing", statusLabel: "Verifying final position state", nextStep: "wait" }),
        registerSnapshot: async () => undefined,
        reconcile: async () => ({ state: "indexing", statusLabel: "Execution delayed", nextStep: "refresh" }),
      },
    });

    const result = await service.getPosition(positionId);

    expect(result.position.state).toBe("indexing");
    expect(result.position.statusLabel).toBe("Execution delayed");
    expect(result.recovery?.headline).toBe("Still waiting on the final snapshot");
    expect(result.activity.at(-1)?.recovery?.safeNextStep).toBe("refresh");
  });

  it("recovers indexing after the process-level indexer is recreated", async () => {
    const positionId = "pos_3";

    await db.createPosition({
      id: positionId,
      intentId: "intent_3",
      action: "add-liquidity",
      mode: "fast-private",
      state: "awaiting_signature",
      poolSlug: "sol-usdc",
      amount: "1.25",
    });
    await db.createExecutionSession({
      id: "session_3",
      positionId,
      state: "awaiting_signature",
      failureStage: null,
    });
    await db.createActivity({
      id: "activity_3",
      positionId,
      action: "add-liquidity",
      state: "awaiting_signature",
      headline: "Intent received",
      detail: "Queued a draft SOL / USDC position for signature review.",
      safeNextStep: "wait",
    });

    const firstIndexer = createPositionIndexer({ store: db });
    const firstService = createPositionService(db, {
      privacyAdapter: new MockPrivacyAdapter(),
      meteoraExecutor: createMockMeteoraExecutor(),
      positionIndexer: firstIndexer,
    });

    const indexing = await firstService.executeSignedIntent({
      positionId,
      signedMessage: "base64sig",
    });

    expect(indexing.position.state).toBe("indexing");

    const secondIndexer = createPositionIndexer({ store: db });
    const secondService = createPositionService(db, {
      positionIndexer: secondIndexer,
    });

    const reconciled = await secondService.getPosition(positionId);

    expect(reconciled.position.state).toBe("active");
    expect(reconciled.session.state).toBe("active");
    expect(reconciled.position.statusLabel).toBe("Position active");
  });
});
