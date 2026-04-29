import { beforeEach, describe, expect, it } from "vitest";

import { createMockMeteoraExecutor } from "#modules/execution/clients";
import { MockPrivacyAdapter } from "#modules/execution/adapters";
import { createMemoryRepositories } from "#test-kit/memory-db";

import { createPositionService } from "../position.service";

describe("claim and withdraw-close flows", () => {
  let repos = createMemoryRepositories();

  beforeEach(() => {
    repos = createMemoryRepositories();
  });

  it("claims fees from an active position and marks it completed", async () => {
    const positionId = "pos_1";

    await repos.positionRepo.createPosition({
      id: positionId,
      intentId: "intent_1",
      action: "add-liquidity",
      mode: "fast-private",
      state: "active",
      poolSlug: "sol-usdc",
      amount: "1.25",
    });
    await repos.positionRepo.createExecutionSession({
      id: "session_1",
      positionId,
      state: "active",
      failureStage: null,
    });
    await repos.activityRepo.createActivity({
      id: "activity_1",
      positionId,
      action: "add-liquidity",
      state: "active",
      headline: "Position active",
      detail: "The final snapshot is available and the position is now live.",
      safeNextStep: "wait",
    });

    const service = createPositionService({
      ...repos,
      privacyAdapter: new MockPrivacyAdapter(),
      meteoraExecutor: createMockMeteoraExecutor(),
    });

    const result = await service.claimPosition({ positionId });

    expect(result.position.state).toBe("completed");
    expect(result.session.state).toBe("completed");
    expect(result.position.statusLabel).toBe("Completed");
    expect(result.activity.map((item) => item.state)).toEqual([
      "active",
      "claiming",
      "indexing",
      "completed",
    ]);
    expect(result.activity.map((item) => item.headline)).toEqual([
      "Position active",
      "Claiming fees",
      "Reconciling claim",
      "Claim completed",
    ]);
  });

  it("withdraws, closes, and settles an active position", async () => {
    const positionId = "pos_2";

    await repos.positionRepo.createPosition({
      id: positionId,
      intentId: "intent_2",
      action: "add-liquidity",
      mode: "fast-private",
      state: "active",
      poolSlug: "sol-usdc",
      amount: "2.50",
    });
    await repos.positionRepo.createExecutionSession({
      id: "session_2",
      positionId,
      state: "active",
      failureStage: null,
    });
    await repos.activityRepo.createActivity({
      id: "activity_2",
      positionId,
      action: "add-liquidity",
      state: "active",
      headline: "Position active",
      detail: "The final snapshot is available and the position is now live.",
      safeNextStep: "wait",
    });

    const service = createPositionService({
      ...repos,
      privacyAdapter: new MockPrivacyAdapter(),
      meteoraExecutor: createMockMeteoraExecutor(),
    });

    const result = await service.withdrawClosePosition({ positionId });

    expect(result.position.state).toBe("completed");
    expect(result.session.state).toBe("completed");
    expect(result.position.statusLabel).toBe("Completed");
    expect(result.activity.map((item) => item.state)).toEqual([
      "active",
      "withdrawing",
      "closing",
      "indexing",
      "completed",
    ]);
    expect(result.activity.map((item) => item.headline)).toEqual([
      "Position active",
      "Withdrawing liquidity",
      "Closing position",
      "Reconciling exit",
      "Withdraw-close completed",
    ]);
  });
});
