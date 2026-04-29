import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

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

export interface ActivityRow {
  id: string;
  positionId: string;
  action: string;
  state: string;
  headline: string;
  detail: string;
  safeNextStep: string;
  createdAt: Date;
}

export interface PositionReconciliationRow {
  positionId: string;
  signature: string | null;
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

export interface CreateActivityInput {
  id: string;
  positionId: string;
  action: string;
  state: string;
  headline: string;
  detail: string;
  safeNextStep: string;
}

export interface OrchestratorDb {
  createPosition(input: CreatePositionInput): Promise<PositionRow>;
  updatePositionState(positionId: string, state: string): Promise<PositionRow>;
  getPositionById(positionId: string): Promise<PositionRow | null>;
  createExecutionSession(input: CreateSessionInput): Promise<ExecutionSessionRow>;
  updateExecutionSession(positionId: string, state: string, failureStage?: string | null): Promise<ExecutionSessionRow>;
  getLatestExecutionSession(positionId: string): Promise<ExecutionSessionRow | null>;
  createActivity(input: CreateActivityInput): Promise<ActivityRow>;
  listActivities(positionId: string): Promise<ActivityRow[]>;
  load(positionId: string): Promise<PositionReconciliationRow | null>;
  save(input: { positionId: string; signature: string | null }): Promise<PositionReconciliationRow>;
  clear(positionId: string): Promise<void>;
}

function createPrismaClient(): PrismaClient {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export function createPrismaDb(
  client = createPrismaClient()
): OrchestratorDb {
  return {
    createPosition: (input) => client.position.create({ data: input }),
    updatePositionState: (positionId, state) => client.position.update({ where: { id: positionId }, data: { state } }),
    getPositionById: (positionId) => client.position.findUnique({ where: { id: positionId } }),
    createExecutionSession: (input) => client.executionSession.create({ data: input }),
    updateExecutionSession: async (positionId, state, failureStage = null) => {
      const latest = await client.executionSession.findFirst({ where: { positionId }, orderBy: { createdAt: "desc" } });
      if (!latest) {
        throw new Error(`Execution session for ${positionId} not found`);
      }

      return client.executionSession.update({
        where: { id: latest.id },
        data: { state, failureStage },
      });
    },
    getLatestExecutionSession: (positionId) =>
      client.executionSession.findFirst({ where: { positionId }, orderBy: { createdAt: "desc" } }),
    createActivity: (input) => client.activity.create({ data: input }),
    listActivities: (positionId) => client.activity.findMany({ where: { positionId }, orderBy: { createdAt: "asc" } }),
    load: (positionId) => client.positionReconciliation.findUnique({ where: { positionId } }),
    save: (input) =>
      client.positionReconciliation.upsert({
        where: { positionId: input.positionId },
        create: input,
        update: { signature: input.signature },
      }),
    clear: (positionId) => client.positionReconciliation.deleteMany({ where: { positionId } }).then(() => undefined),
  };
}
