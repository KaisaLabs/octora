import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";

export interface PositionRow {
  id: string;
  intentId: string;
  walletAddress: string;
  action: string;
  mode: string;
  state: string;
  poolSlug: string;
  amount: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PersistedDepositIntentRow {
  nullifierHash: string;
  positionId: string;
  commitment: string;
  intendedPool: string;
  denom: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExecutionSessionRow {
  id: string;
  positionId: string;
  state: string;
  failureStage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePositionInput {
  id: string;
  intentId: string;
  walletAddress: string;
  action: string;
  mode: string;
  state: string;
  poolSlug: string;
  amount: string;
}

/**
 * Terminal states excluded from "active" cap math. Anything else
 * (draft, funding, indexing, active, withdrawing, ...) is still holding
 * or about to hold capital and counts toward the beta caps.
 */
export const TERMINAL_POSITION_STATES = ["completed", "failed", "WITHDRAWN"] as const;

export interface CreateSessionInput {
  id: string;
  positionId: string;
  state: string;
  failureStage?: string | null;
}

export interface PositionRepository {
  createPosition(input: CreatePositionInput): Promise<PositionRow>;
  updatePositionState(positionId: string, state: string): Promise<PositionRow>;
  updatePositionMode(positionId: string, mode: string): Promise<PositionRow>;
  getPositionById(positionId: string): Promise<PositionRow | null>;
  createExecutionSession(input: CreateSessionInput): Promise<ExecutionSessionRow>;
  updateExecutionSession(positionId: string, state: string, failureStage?: string | null): Promise<ExecutionSessionRow>;
  getLatestExecutionSession(positionId: string): Promise<ExecutionSessionRow | null>;
  /** Count of non-terminal positions owned by `walletAddress`. */
  countActiveByWallet(walletAddress: string): Promise<number>;
  /**
   * Sum of `amount` (SOL decimal string) over all non-terminal positions.
   * Returns a `number` because beta caps are in SOL. Backed by a single
   * Postgres aggregate (`SUM(amount::numeric)`) so memory cost is constant
   * regardless of active-row count — earlier impls pulled rows and reduced
   * in JS, which would OOM if the active set grew unbounded.
   */
  sumActiveAmountSol(): Promise<number>;
  /**
   * Positions in `state` whose `updatedAt` is older than `cutoff`. Used by
   * the recovery worker (P1-29) to find stuck transitions; bounded by
   * `limit` so a runaway count can't load the whole table.
   */
  findStuckPositions(state: string, cutoff: Date, limit: number): Promise<PositionRow[]>;
  /**
   * Positions that entered `failed` since `since`. Used by the recovery
   * worker to alert exactly once on each new failure rather than firing
   * on every poll tick.
   */
  findRecentlyFailed(since: Date, limit: number): Promise<PositionRow[]>;
  /**
   * Count of positions grouped by `state`. Powers the `/metrics`
   * snapshot. Terminal states are included so monitors can see
   * lifetime distribution, not just live load.
   */
  countByState(): Promise<Record<string, number>>;
  persistDepositIntent(input: Omit<PersistedDepositIntentRow, "createdAt" | "updatedAt">): Promise<PersistedDepositIntentRow>;
  getDepositIntent(nullifierHash: string): Promise<PersistedDepositIntentRow | null>;
  clearDepositIntent(nullifierHash: string): Promise<void>;
  clearDepositIntentForPosition(positionId: string): Promise<void>;
}

export function createPrismaPositionRepository(client: PrismaClient): PositionRepository {
  const terminalFilter = { state: { notIn: [...TERMINAL_POSITION_STATES] } };
  return {
    createPosition: (input) => client.position.create({ data: input }),
    updatePositionState: (positionId, state) =>
      client.position.update({ where: { id: positionId }, data: { state } }),
    updatePositionMode: (positionId, mode) =>
      client.position.update({ where: { id: positionId }, data: { mode } }),
    getPositionById: (positionId) =>
      client.position.findUnique({ where: { id: positionId } }),
    createExecutionSession: (input) =>
      client.executionSession.create({ data: input }),
    updateExecutionSession: async (positionId, state, failureStage = null) => {
      const latest = await client.executionSession.findFirst({
        where: { positionId },
        orderBy: { createdAt: "desc" },
      });
      if (!latest) {
        throw new Error(`Execution session for ${positionId} not found`);
      }
      return client.executionSession.update({
        where: { id: latest.id },
        data: { state, failureStage },
      });
    },
    getLatestExecutionSession: (positionId) =>
      client.executionSession.findFirst({
        where: { positionId },
        orderBy: { createdAt: "desc" },
      }),
    countActiveByWallet: (walletAddress) =>
      client.position.count({ where: { walletAddress, ...terminalFilter } }),
    sumActiveAmountSol: async () => {
      // Cast TEXT -> NUMERIC inside Postgres so the work happens server-side.
      // The partial index `Position_active_amount_idx` (state, amount) covers
      // the filter; with the active set excluded, terminal rows never get
      // scanned. Result row is `{ sum: Decimal | null }` — null when zero
      // active rows. NUMERIC arrives as a Prisma Decimal, so use toNumber()
      // rather than letting JS coerce a string with trailing precision.
      // The driver may return NUMERIC as a Prisma.Decimal, a string, or a
      // number depending on adapter / driver version, so coerce through
      // `Number(...)` and guard against NaN rather than typing it tightly.
      type Row = { sum: Prisma.Decimal | string | number | null };
      const rows = await client.$queryRaw<Row[]>`
        SELECT SUM("amount"::numeric) AS sum
        FROM "Position"
        WHERE "state" NOT IN ('completed', 'failed')
      `;
      const raw = rows[0]?.sum ?? null;
      if (raw === null) return 0;
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    },
    findStuckPositions: (state, cutoff, limit) =>
      client.position.findMany({
        where: { state, updatedAt: { lt: cutoff } },
        orderBy: { updatedAt: "asc" },
        take: limit,
      }),
    findRecentlyFailed: (since, limit) =>
      client.position.findMany({
        where: { state: "failed", updatedAt: { gte: since } },
        orderBy: { updatedAt: "desc" },
        take: limit,
      }),
    countByState: async () => {
      const grouped = await client.position.groupBy({
        by: ["state"],
        _count: { _all: true },
      });
      const out: Record<string, number> = {};
      for (const row of grouped) out[row.state] = row._count._all;
      return out;
    },
    persistDepositIntent: async (input) =>
      client.persistedDepositIntent.upsert({
        where: { nullifierHash: input.nullifierHash },
        create: input,
        update: {
          positionId: input.positionId,
          commitment: input.commitment,
          intendedPool: input.intendedPool,
          denom: input.denom,
          expiresAt: input.expiresAt,
        },
      }),
    getDepositIntent: (nullifierHash) =>
      client.persistedDepositIntent.findUnique({ where: { nullifierHash } }),
    clearDepositIntent: async (nullifierHash) => {
      // `deleteMany` is the no-throw variant — the aggregate clears on every
      // terminal transition, even if the intent was never persisted (standard
      // mode positions, draft -> failed). A bare `delete` would raise P2025.
      await client.persistedDepositIntent.deleteMany({ where: { nullifierHash } });
    },
    clearDepositIntentForPosition: async (positionId) => {
      await client.persistedDepositIntent.deleteMany({ where: { positionId } });
    },
  };
}
