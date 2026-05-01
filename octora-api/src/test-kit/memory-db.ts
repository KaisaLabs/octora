import type {
  PositionRepository,
  PositionRow,
  ExecutionSessionRow,
  CreatePositionInput,
  CreateSessionInput,
} from "#modules/positions/position.repository";
import type {
  ActivityRepository,
  ActivityRow,
  CreateActivityInput,
} from "#modules/positions/activity.repository";
import type {
  ReconciliationRepository,
  PositionReconciliationRecord,
} from "#modules/indexer/indexer.repository";
import type { WaitlistRepository } from "#modules/waitlist/waitlist.repository";

const FIXED_DATE = new Date("2026-04-29T09:00:00.000Z");

export function createMemoryPositionRepository(): PositionRepository {
  const positions = new Map<string, PositionRow>();
  const sessions = new Map<string, ExecutionSessionRow[]>();

  return {
    async createPosition(input: CreatePositionInput) {
      const row: PositionRow = {
        ...input,
        createdAt: FIXED_DATE,
        updatedAt: FIXED_DATE,
      };
      positions.set(row.id, row);
      return row;
    },
    async updatePositionState(positionId: string, state: string) {
      const current = positions.get(positionId);
      if (!current) {
        throw new Error(`Position ${positionId} not found`);
      }
      const row: PositionRow = { ...current, state, updatedAt: FIXED_DATE };
      positions.set(positionId, row);
      return row;
    },
    async getPositionById(positionId: string) {
      return positions.get(positionId) ?? null;
    },
    async createExecutionSession(input: CreateSessionInput) {
      const row: ExecutionSessionRow = {
        id: input.id,
        positionId: input.positionId,
        state: input.state,
        failureStage: input.failureStage ?? null,
        createdAt: FIXED_DATE,
        updatedAt: FIXED_DATE,
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
      const row: ExecutionSessionRow = { ...current, state, failureStage, updatedAt: FIXED_DATE };
      sessions.set(positionId, [...items.slice(0, -1), row]);
      return row;
    },
    async getLatestExecutionSession(positionId: string) {
      const items = sessions.get(positionId) ?? [];
      return items.at(-1) ?? null;
    },
  };
}

export function createMemoryActivityRepository(): ActivityRepository {
  const activities = new Map<string, ActivityRow[]>();

  return {
    async createActivity(input: CreateActivityInput) {
      const row: ActivityRow = { ...input, createdAt: FIXED_DATE };
      activities.set(input.positionId, [...(activities.get(input.positionId) ?? []), row]);
      return row;
    },
    async listActivities(positionId: string) {
      return activities.get(positionId) ?? [];
    },
  };
}

export function createMemoryReconciliationRepository(): ReconciliationRepository {
  const entries = new Map<string, PositionReconciliationRecord>();

  return {
    async load(positionId: string) {
      return entries.get(positionId) ?? null;
    },
    async save(record: PositionReconciliationRecord) {
      entries.set(record.positionId, record);
      return record;
    },
    async clear(positionId: string) {
      entries.delete(positionId);
    },
  };
}

export function createMemoryWaitlistRepository(): WaitlistRepository {
  const entries = new Map<string, { id: string; email: string; createdAt: Date }>();

  return {
    async add(email, source) {
      const entry = { id: `wl-${entries.size + 1}`, email, source: source ?? null, createdAt: new Date() };
      entries.set(email, entry);
      return entry;
    },
    async exists(email) {
      return entries.has(email);
    },
  };
}

export function createMemoryRepositories() {
  return {
    positionRepo: createMemoryPositionRepository(),
    activityRepo: createMemoryActivityRepository(),
    reconciliationRepo: createMemoryReconciliationRepository(),
    waitlistRepo: createMemoryWaitlistRepository(),
  };
}
