import { describe, expect, it } from "vitest";

import type { PositionReconciliationRecord, PositionReconciliationStore } from "../position-indexer";
import { createPositionIndexer } from "../position-indexer";

function createMemoryStore(): PositionReconciliationStore {
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

describe("position indexer", () => {
  it("keeps a position in indexing until a snapshot is available", async () => {
    const store = createMemoryStore();
    const indexer = createPositionIndexer({ store });

    const initial = await indexer.beginReconciliation({ positionId: "position-1" });
    expect(initial.state).toBe("indexing");
    expect(initial.statusLabel).toBe("Verifying final position state");
    expect(initial.nextStep).toBe("wait");

    const pending = await indexer.reconcile("position-1");
    expect(pending.state).toBe("indexing");
    expect(pending.statusLabel).toBe("Execution delayed");
    expect(pending.nextStep).toBe("refresh");

    await indexer.registerSnapshot({ positionId: "position-1", signature: "sig_1" });

    const completed = await indexer.reconcile("position-1");
    expect(completed.state).toBe("active");
    expect(completed.statusLabel).toBe("Position active");
    expect(completed.nextStep).toBe("wait");
  });

  it("recovers a pending reconciliation entry after the indexer is recreated", async () => {
    const store = createMemoryStore();
    const firstIndexer = createPositionIndexer({ store });

    await firstIndexer.beginReconciliation({ positionId: "position-2" });
    await firstIndexer.registerSnapshot({ positionId: "position-2", signature: "sig_2" });

    const secondIndexer = createPositionIndexer({ store });
    const result = await secondIndexer.reconcile("position-2");

    expect(result.state).toBe("active");
    expect(result.statusLabel).toBe("Position active");
  });
});
