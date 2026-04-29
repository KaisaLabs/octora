import { PrismaClient } from "@prisma/client";

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
  getPositionById(positionId: string): Promise<PositionRow | null>;
  createExecutionSession(input: CreateSessionInput): Promise<ExecutionSessionRow>;
  getLatestExecutionSession(positionId: string): Promise<ExecutionSessionRow | null>;
  createActivity(input: CreateActivityInput): Promise<ActivityRow>;
  listActivities(positionId: string): Promise<ActivityRow[]>;
}

export function createPrismaDb(client = new PrismaClient()): OrchestratorDb {
  return {
    createPosition: (input) => client.position.create({ data: input }),
    getPositionById: (positionId) => client.position.findUnique({ where: { id: positionId } }),
    createExecutionSession: (input) => client.executionSession.create({ data: input }),
    getLatestExecutionSession: (positionId) =>
      client.executionSession.findFirst({ where: { positionId }, orderBy: { createdAt: "desc" } }),
    createActivity: (input) => client.activity.create({ data: input }),
    listActivities: (positionId) => client.activity.findMany({ where: { positionId }, orderBy: { createdAt: "asc" } }),
  };
}
