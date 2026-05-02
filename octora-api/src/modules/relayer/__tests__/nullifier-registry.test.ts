import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryNullifierRegistry } from "../nullifier-registry.js";

describe("InMemoryNullifierRegistry", () => {
  let registry: InMemoryNullifierRegistry;

  beforeEach(() => {
    registry = new InMemoryNullifierRegistry();
  });

  it("starts empty", async () => {
    expect(await registry.count()).toBe(0);
    expect(await registry.isSpent("any-hash")).toBe(false);
  });

  it("marks nullifiers as spent", async () => {
    await registry.markSpent("hash-1", "tx-sig-1");

    expect(await registry.isSpent("hash-1")).toBe(true);
    expect(await registry.count()).toBe(1);
  });

  it("rejects double-spend", async () => {
    await registry.markSpent("hash-1", "tx-sig-1");

    await expect(registry.markSpent("hash-1", "tx-sig-2")).rejects.toThrow("already spent");
  });

  it("tracks multiple nullifiers independently", async () => {
    await registry.markSpent("hash-1", "tx-sig-1");
    await registry.markSpent("hash-2", "tx-sig-2");

    expect(await registry.isSpent("hash-1")).toBe(true);
    expect(await registry.isSpent("hash-2")).toBe(true);
    expect(await registry.isSpent("hash-3")).toBe(false);
    expect(await registry.count()).toBe(2);
  });
});
