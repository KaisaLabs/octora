import { describe, expect, it } from "vitest";

import { createRecoveryService } from "../recovery.service";

describe("recovery service", () => {
  it("maps pre-funding fallback to post-hoc downgrade disclosure", () => {
    const service = createRecoveryService();

    const guidance = service.getRecoveryGuidance({
      failureStage: "pre-funding",
      mode: "fast-private",
    });

    expect(guidance).toEqual({
      headline: "Position downgraded to standard mode",
      message: "Octora downgraded this Position to standard mode to keep the trade window open. Your origin wallet is now linked to this Position.",
      safeNextStep: "wait",
      terminal: true,
      fallbackMode: "standard",
      surfaceDowngradeDisclosure: true,
    });
  });

  it("maps funding-partial failures to a terminal recovery state", () => {
    const service = createRecoveryService();

    const guidance = service.getRecoveryGuidance({
      failureStage: "funding-partial",
      mode: "fast-private",
    });

    expect(guidance?.headline).toBe("Position downgraded to standard mode");
    expect(guidance?.safeNextStep).toBe("wait");
    expect(guidance?.terminal).toBe(true);
  });

  it("maps indexing lag to a non-terminal refresh state", () => {
    const service = createRecoveryService();

    const guidance = service.getRecoveryGuidance({
      failureStage: "indexing-lag",
      mode: "standard",
    });

    expect(guidance?.headline).toBe("Still waiting on the final snapshot");
    expect(guidance?.safeNextStep).toBe("refresh");
    expect(guidance?.terminal).toBe(false);
  });

  it("allows post-hoc fallback without requiring a pre-execution disclosure gate", () => {
    const service = createRecoveryService();

    expect(
      service.resolveExecutionMode({
        selectedMode: "fast-private",
        fallbackMode: "standard",
        surfacedFallback: false,
      }),
    ).toEqual({
      mode: "standard",
      downgradedFrom: "fast-private",
      surfacedFallback: false,
    });
  });
});
