import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "#app";
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

      const now = new Date("2026-04-29T09:00:00.000Z");
      const row: PositionRow = {
        ...current,
        state,
        updatedAt: now,
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

describe("position routes", () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    app = await createApp({ db: createMemoryDb() });
  });

  it("creates a draft position intent and returns awaiting-signature state data", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/positions/intents",
      payload: {
        action: "add-liquidity",
        amount: "1.25",
        pool: "sol-usdc",
        mode: "fast-private",
      },
    });

    expect(response.statusCode).toBe(201);

    const body = response.json() as {
      intent: { state: string; positionId: string };
      position: { id: string; state: string; statusLabel: string; amountLabel: string; poolLabel: string; modeLabel: string };
      session: { state: string };
      activity: Array<{ state: string; headline: string }>;
    };

    expect(body.intent.state).toBe("draft");
    expect(body.position.state).toBe("draft");
    expect(body.position.statusLabel).toBe("Awaiting signature");
    expect(body.session.state).toBe("awaiting_signature");
    expect(body.activity[0].state).toBe("awaiting_signature");
    expect(body.activity[0].headline).toBe("Intent received");

    const readResponse = await app.inject({
      method: "GET",
      url: `/positions/${body.position.id}`,
    });

    expect(readResponse.statusCode).toBe(200);
    const readBody = readResponse.json() as typeof body;
    expect(readBody.position.id).toBe(body.position.id);
    expect(readBody.position.state).toBe("draft");
    expect(readBody.session.state).toBe("awaiting_signature");
  });

  it("returns 404 for an unknown position", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/positions/missing-position",
    });

    expect(response.statusCode).toBe(404);
  });
});
