import { describe, expect, it } from "vitest";

import { createRecoveryService } from "../recovery.service";

describe("recovery service", () => {
  it("maps pre-funding failures to plain-language guidance", () => {
    const service = createRecoveryService();

    const guidance = service.getRecoveryGuidance({
      failureStage: "pre-funding",
      mode: "fast-private",
    });

    expect(guidance).toEqual({
      headline: "Funding could not start",
      message: "Octora stopped before any funds moved. Check the balance, then retry from the beginning.",
      safeNextStep: "retry",
      terminal: true,
      fallbackMode: "standard",
      downgradeRequiresDisclosure: true,
    });
  });

  it("maps funding-partial failures to a terminal recovery state", () => {
    const service = createRecoveryService();

    const guidance = service.getRecoveryGuidance({
      failureStage: "funding-partial",
      mode: "fast-private",
    });

    expect(guidance?.headline).toBe("Funding started, but did not finish cleanly");
    expect(guidance?.safeNextStep).toBe("contact-support");
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

  it("blocks silent downgrades unless the fallback was surfaced first", () => {
    const service = createRecoveryService();

    expect(() =>
      service.resolveExecutionMode({
        selectedMode: "fast-private",
        fallbackMode: "standard",
        surfacedFallback: false,
      }),
    ).toThrow(/must be surfaced before execution starts/i);

    expect(
      service.resolveExecutionMode({
        selectedMode: "fast-private",
        fallbackMode: "standard",
        surfacedFallback: true,
      }),
    ).toEqual({
      mode: "standard",
      downgradedFrom: "fast-private",
      surfacedFallback: true,
    });
  });
});
