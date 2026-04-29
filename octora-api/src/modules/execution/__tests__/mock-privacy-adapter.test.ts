import { describe, expect, it } from "vitest";

import { MockPrivacyAdapter } from "../adapters/mock-privacy.adapter";

describe("MockPrivacyAdapter", () => {
  it("exposes MVP-ready capabilities and deterministic receipts", async () => {
    const adapter = new MockPrivacyAdapter();

    expect(adapter.capabilities()).toEqual({
      adapter: "mock",
      live: true,
      mvpReady: true,
      deterministicReceipts: true,
    });

    const fundingReceipt = await adapter.prepareFunding({
      positionId: "position-123",
      intentId: "intent-123",
      poolSlug: "sol-usdc",
      amount: "1.25",
      mode: "fast-private",
    });

    expect(fundingReceipt).toEqual({
      receiptId: "mock-funding-position-123",
      adapter: "mock",
      action: "prepare_funding",
      positionId: "position-123",
      podId: "pod-position-123",
      status: "prepared",
      summary: "Prepared mock funding path for position position-123.",
      createdAtIso: "2026-04-29T09:00:00.000Z",
    });

    const exitReceipt = await adapter.prepareExit({
      positionId: "position-123",
      intentId: "intent-123",
      mode: "fast-private",
    });

    expect(exitReceipt).toEqual({
      receiptId: "mock-exit-position-123",
      adapter: "mock",
      action: "prepare_exit",
      positionId: "position-123",
      podId: "pod-position-123",
      status: "prepared",
      summary: "Prepared mock exit path for position position-123.",
      createdAtIso: "2026-04-29T09:00:00.000Z",
    });
  });
});
