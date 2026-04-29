import type { ActivityRecord, ExecutionState } from "#domain";

export interface PositionReconciliationInput {
  positionId: string;
}

export interface IndexerSnapshot {
  positionId: string;
  signature: string;
}

export interface PositionReconciliationRecord {
  positionId: string;
  signature: string | null;
}

export interface PositionReconciliationStore {
  load(positionId: string): Promise<PositionReconciliationRecord | null>;
  save(record: PositionReconciliationRecord): Promise<PositionReconciliationRecord>;
  clear(positionId: string): Promise<void>;
}

export interface PositionIndexerBeginResult {
  state: Extract<ExecutionState, "indexing">;
  statusLabel: string;
  nextStep: ActivityRecord["safeNextStep"];
}

export interface PositionIndexerReconcileResult {
  state: Extract<ExecutionState, "indexing" | "active">;
  statusLabel: string;
  nextStep: ActivityRecord["safeNextStep"];
}

export interface PositionIndexer {
  beginReconciliation(input: PositionReconciliationInput): Promise<PositionIndexerBeginResult>;
  registerSnapshot(snapshot: IndexerSnapshot): Promise<void>;
  reconcile(positionId: string): Promise<PositionIndexerReconcileResult>;
}

export function createPositionIndexer(options: { store: PositionReconciliationStore }): PositionIndexer {
  const { store } = options;

  return {
    async beginReconciliation({ positionId }) {
      await store.save({ positionId, signature: null });
      return {
        state: "indexing",
        statusLabel: "Verifying final position state",
        nextStep: "wait",
      };
    },
    async registerSnapshot(snapshot) {
      await store.save(snapshot);
    },
    async reconcile(positionId) {
      const entry = await store.load(positionId);
      if (!entry?.signature) {
        return {
          state: "indexing",
          statusLabel: "Execution delayed",
          nextStep: "refresh",
        };
      }

      await store.clear(positionId);
      return {
        state: "active",
        statusLabel: "Position active",
        nextStep: "wait",
      };
    },
  };
}
