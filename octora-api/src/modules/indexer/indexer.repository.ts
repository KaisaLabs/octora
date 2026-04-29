import type { PrismaClient } from "@prisma/client";

export interface PositionReconciliationRow {
  positionId: string;
  signature: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PositionReconciliationRecord {
  positionId: string;
  signature: string | null;
}

export interface ReconciliationRepository {
  load(positionId: string): Promise<PositionReconciliationRecord | null>;
  save(record: PositionReconciliationRecord): Promise<PositionReconciliationRecord>;
  clear(positionId: string): Promise<void>;
}

export function createPrismaReconciliationRepository(client: PrismaClient): ReconciliationRepository {
  return {
    load: (positionId) =>
      client.positionReconciliation.findUnique({ where: { positionId } }),
    save: (input) =>
      client.positionReconciliation.upsert({
        where: { positionId: input.positionId },
        create: input,
        update: { signature: input.signature },
      }),
    clear: (positionId) =>
      client.positionReconciliation.deleteMany({ where: { positionId } }).then(() => undefined),
  };
}
