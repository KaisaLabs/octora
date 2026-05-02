import { describe, it, expect, beforeEach } from "vitest";
import { DepositService } from "../deposit.service.js";

describe("DepositService", () => {
  let service: DepositService;

  beforeEach(async () => {
    service = new DepositService();
    await service.initialize();
  });

  it("starts with empty tree", () => {
    expect(service.depositCount()).toBe(0);
    expect(service.currentRoot()).toBeTruthy(); // has a zero-root
  });

  it("creates commitments", async () => {
    const commitment = await service.createCommitment();

    expect(commitment.secret).toBeTypeOf("bigint");
    expect(commitment.nullifier).toBeTypeOf("bigint");
    expect(commitment.commitment).toBeTypeOf("bigint");
    expect(commitment.nullifierHash).toBeTypeOf("bigint");
  });

  it("records deposits and updates Merkle root", () => {
    const rootBefore = service.currentRoot();

    const leafIndex = service.recordDeposit(123456789n, "tx-sig-1", 1700000000);

    expect(leafIndex).toBe(0);
    expect(service.depositCount()).toBe(1);
    expect(service.currentRoot()).not.toBe(rootBefore);
  });

  it("finds commitments by value", () => {
    service.recordDeposit(111n, "tx-1", 1700000000);
    service.recordDeposit(222n, "tx-2", 1700000001);

    expect(service.findCommitment(111n)).toBe(0);
    expect(service.findCommitment(222n)).toBe(1);
    expect(service.findCommitment(333n)).toBe(-1);
  });

  it("throws if not initialized", () => {
    const uninitService = new DepositService();

    expect(() => uninitService.currentRoot()).toThrow("not initialized");
  });

  it("initializes with existing commitments", async () => {
    const existingService = new DepositService();
    await existingService.initialize([100n, 200n, 300n]);

    expect(existingService.depositCount()).toBe(3);
    expect(existingService.findCommitment(200n)).toBe(1);
  });
});
