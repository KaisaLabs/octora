import type { PrismaClient } from "@prisma/client";

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

export interface CreateActivityInput {
  id: string;
  positionId: string;
  action: string;
  state: string;
  headline: string;
  detail: string;
  safeNextStep: string;
}

export interface ActivityRepository {
  createActivity(input: CreateActivityInput): Promise<ActivityRow>;
  listActivities(positionId: string): Promise<ActivityRow[]>;
}

export function createPrismaActivityRepository(client: PrismaClient): ActivityRepository {
  return {
    createActivity: (input) => client.activity.create({ data: input }),
    listActivities: (positionId) =>
      client.activity.findMany({
        where: { positionId },
        orderBy: { createdAt: "asc" },
      }),
  };
}
