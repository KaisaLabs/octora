import { describe, expect, it } from "vitest";

import { canTransition, modePolicy } from "../index";

describe("execution state machine", () => {
  it("allows add-liquidity happy path to settle into active", () => {
    expect(canTransition("draft", "awaiting_signature")).toBe(true);
    expect(canTransition("awaiting_signature", "funding_in_progress")).toBe(true);
    expect(canTransition("funding_in_progress", "executing_on_meteora")).toBe(true);
    expect(canTransition("executing_on_meteora", "indexing")).toBe(true);
    expect(canTransition("indexing", "active")).toBe(true);
  });

  it("blocks invalid transitions from failed and completed", () => {
    expect(canTransition("failed", "active")).toBe(false);
    expect(canTransition("failed", "awaiting_signature")).toBe(false);
    expect(canTransition("completed", "active")).toBe(false);
    expect(canTransition("completed", "indexing")).toBe(false);
  });

  it("validates the two-phase deposit to LP fallback substates", () => {
    expect(canTransition("DEPOSITED", "LP_PENDING")).toBe(true);
    expect(canTransition("LP_PENDING", "LP_FAILED")).toBe(true);
    expect(canTransition("LP_PENDING", "LP_DONE")).toBe(true);
    expect(canTransition("LP_FAILED", "LP_RETRIED")).toBe(true);
    expect(canTransition("LP_FAILED", "PARKED")).toBe(true);
    expect(canTransition("LP_FAILED", "WITHDRAWN")).toBe(true);
    expect(canTransition("PARKED", "LP_RETRIED")).toBe(true);
    expect(canTransition("LP_RETRIED", "LP_DONE")).toBe(true);

    expect(canTransition("DEPOSITED", "LP_DONE")).toBe(false);
    expect(canTransition("PARKED", "LP_DONE")).toBe(false);
    expect(canTransition("WITHDRAWN", "LP_RETRIED")).toBe(false);
  });
});

describe("mode policy", () => {
  it("exposes the canonical standard and fast private values", () => {
    expect(modePolicy.standard).toEqual({
      label: "Standard",
      fundingTtlMinutes: 10,
      allowFallbackToStandard: false,
      podReuseWithinPosition: true,
    });

    expect(modePolicy["fast-private"]).toEqual({
      label: "Fast Private",
      fundingTtlMinutes: 15,
      allowFallbackToStandard: true,
      podReuseWithinPosition: true,
    });
  });
});
