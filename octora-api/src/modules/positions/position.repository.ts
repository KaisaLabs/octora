import type { PrismaClient } from "@prisma/client";

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
export const TERMINAL_POSITION_STATES = ["completed", "failed"] as const;

export interface CreateSessionInput {
  id: string;
  positionId: string;
  state: string;
  failureStage?: string | null;
}

export interface PositionRepository {
  createPosition(input: CreatePositionInput): Promise<PositionRow>;
  updatePositionState(positionId: string, state: string): Promise<PositionRow>;
  getPositionById(positionId: string): Promise<PositionRow | null>;
  createExecutionSession(input: CreateSessionInput): Promise<ExecutionSessionRow>;
  updateExecutionSession(positionId: string, state: string, failureStage?: string | null): Promise<ExecutionSessionRow>;
  getLatestExecutionSession(positionId: string): Promise<ExecutionSessionRow | null>;
  /** Count of non-terminal positions owned by `walletAddress`. */
  countActiveByWallet(walletAddress: string): Promise<number>;
  /**
   * Sum of `amount` (SOL decimal string) over all non-terminal positions.
   * Returns a `number` because beta caps are in SOL and Postgres SUM
   * over a TEXT column requires a JS-side parse anyway.
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
}

export function createPrismaPositionRepository(client: PrismaClient): PositionRepository {
  const terminalFilter = { state: { notIn: [...TERMINAL_POSITION_STATES] } };
  return {
    createPosition: (input) => client.position.create({ data: input }),
    updatePositionState: (positionId, state) =>
      client.position.update({ where: { id: positionId }, data: { state } }),
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
      // amount is a decimal string in SOL — Prisma can't SUM a TEXT
      // column, so pull active rows and reduce in JS. The caps are bounded
      // (≤500 active positions in beta) so this is fine.
      const active = await client.position.findMany({
        where: terminalFilter,
        select: { amount: true },
      });
      return active.reduce((acc, row) => {
        const v = Number(row.amount);
        return Number.isFinite(v) ? acc + v : acc;
      }, 0);
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
  };
}
