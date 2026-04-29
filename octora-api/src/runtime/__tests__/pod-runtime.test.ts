import { describe, expect, it } from "vitest";

import { MockPodRuntime } from "../pod-runtime";

describe("MockPodRuntime", () => {
  it("creates, reuses, and closes pods deterministically", async () => {
    const runtime = new MockPodRuntime();

    const pod = await runtime.createPod({
      positionId: "position-123",
      mode: "fast-private",
    });

    expect(pod).toEqual({
      id: "pod-position-123",
      positionId: "position-123",
      mode: "fast-private",
      status: "open",
      createdAtIso: "2026-04-29T09:00:00.000Z",
      closedAtIso: null,
    });

    const reusedPod = await runtime.createPod({
      positionId: "position-123",
      mode: "standard",
    });

    expect(reusedPod).toBe(pod);

    const closedPod = await runtime.closePod("pod-position-123");

    expect(closedPod).toEqual({
      ...pod,
      status: "closed",
      closedAtIso: "2026-04-29T09:00:00.000Z",
    });

    expect(await runtime.getPod("pod-position-123")).toEqual(closedPod);
  });
});
