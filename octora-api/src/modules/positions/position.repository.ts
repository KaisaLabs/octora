import type { PrismaClient } from "@prisma/client";

export interface PositionRow {
  id: string;
  intentId: string;
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
  action: string;
  mode: string;
  state: string;
  poolSlug: string;
  amount: string;
}

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
}

export function createPrismaPositionRepository(client: PrismaClient): PositionRepository {
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
  };
}
