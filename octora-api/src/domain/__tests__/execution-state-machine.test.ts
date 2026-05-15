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

  it("rejects illegal jumps across the Deposit LP Fallback cluster (dust/03)", () => {
    // Skipping LP_PENDING — `DEPOSITED` MUST go through LP_PENDING first.
    expect(canTransition("DEPOSITED", "LP_FAILED")).toBe(false);
    expect(canTransition("DEPOSITED", "PARKED")).toBe(false);
    expect(canTransition("DEPOSITED", "WITHDRAWN")).toBe(false);
    expect(canTransition("DEPOSITED", "LP_RETRIED")).toBe(false);

    // LP_PENDING can only land in LP_FAILED or LP_DONE.
    expect(canTransition("LP_PENDING", "PARKED")).toBe(false);
    expect(canTransition("LP_PENDING", "WITHDRAWN")).toBe(false);
    expect(canTransition("LP_PENDING", "LP_RETRIED")).toBe(false);
    expect(canTransition("LP_PENDING", "DEPOSITED")).toBe(false);

    // PARKED is a holding state — the only exits are LP_RETRIED and WITHDRAWN.
    expect(canTransition("PARKED", "LP_PENDING")).toBe(false);
    expect(canTransition("PARKED", "LP_FAILED")).toBe(false);

    // Terminal states are terminal.
    expect(canTransition("LP_DONE", "LP_PENDING")).toBe(false);
    expect(canTransition("LP_DONE", "LP_RETRIED")).toBe(false);
    expect(canTransition("LP_DONE", "WITHDRAWN")).toBe(false);
    expect(canTransition("WITHDRAWN", "LP_DONE")).toBe(false);
    expect(canTransition("WITHDRAWN", "PARKED")).toBe(false);

    // No escaping the cluster back into the legacy `active` lane.
    expect(canTransition("LP_FAILED", "active")).toBe(false);
    expect(canTransition("PARKED", "active")).toBe(false);
    expect(canTransition("LP_DONE", "active")).toBe(false);
  });
});

describe("Private Position Close cluster (close/01)", () => {
  it("allows the close mainline happy path with swap to settle into CLOSED", () => {
    expect(canTransition("active", "CLOSING")).toBe(true);
    expect(canTransition("CLOSING", "SWAPPING")).toBe(true);
    expect(canTransition("SWAPPING", "REMIXING")).toBe(true);
    expect(canTransition("REMIXING", "CLOSED")).toBe(true);
  });

  it("allows the close mainline swap-skip path (CLOSING -> REMIXING directly)", () => {
    expect(canTransition("CLOSING", "REMIXING")).toBe(true);
  });

  it("allows each leg's failure to its matching *_FAILED terminal", () => {
    expect(canTransition("CLOSING", "CLOSE_FAILED")).toBe(true);
    expect(canTransition("SWAPPING", "SWAP_FAILED")).toBe(true);
    expect(canTransition("REMIXING", "REMIX_FAILED")).toBe(true);
  });

  it("rejects illegal jumps across the close cluster", () => {
    // active can only enter the cluster via CLOSING — no direct
    // shortcut to any later state.
    expect(canTransition("active", "CLOSED")).toBe(false);
    expect(canTransition("active", "SWAPPING")).toBe(false);
    expect(canTransition("active", "REMIXING")).toBe(false);

    // CLOSING can only fan out to SWAPPING, REMIXING, or CLOSE_FAILED.
    // It must not jump to a terminal success state or a sibling
    // failure terminal.
    expect(canTransition("CLOSING", "CLOSED")).toBe(false);
    expect(canTransition("CLOSING", "SWAP_FAILED")).toBe(false);
    expect(canTransition("CLOSING", "REMIX_FAILED")).toBe(false);

    // SWAPPING must not skip the REMIXING step.
    expect(canTransition("SWAPPING", "CLOSED")).toBe(false);
    // SWAPPING cannot bounce back to CLOSING.
    expect(canTransition("SWAPPING", "CLOSING")).toBe(false);
    // SWAPPING cannot land in the wrong terminal failure.
    expect(canTransition("SWAPPING", "CLOSE_FAILED")).toBe(false);
    expect(canTransition("SWAPPING", "REMIX_FAILED")).toBe(false);

    // REMIXING cannot rewind or land in the wrong failure terminal.
    expect(canTransition("REMIXING", "CLOSING")).toBe(false);
    expect(canTransition("REMIXING", "SWAPPING")).toBe(false);
    expect(canTransition("REMIXING", "CLOSE_FAILED")).toBe(false);
    expect(canTransition("REMIXING", "SWAP_FAILED")).toBe(false);

    // Terminal states are terminal.
    expect(canTransition("CLOSED", "active")).toBe(false);
    expect(canTransition("CLOSED", "CLOSING")).toBe(false);
    expect(canTransition("CLOSE_FAILED", "CLOSING")).toBe(false);
    expect(canTransition("SWAP_FAILED", "SWAPPING")).toBe(false);
    expect(canTransition("REMIX_FAILED", "REMIXING")).toBe(false);

    // No cross-cluster bleed into the Deposit LP Fallback states or
    // the legacy `active`/`completed` lanes.
    expect(canTransition("CLOSING", "active")).toBe(false);
    expect(canTransition("CLOSED", "completed")).toBe(false);
    expect(canTransition("CLOSING", "LP_PENDING")).toBe(false);
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
