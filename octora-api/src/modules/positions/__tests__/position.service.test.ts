import { beforeEach, describe, expect, it } from "vitest";

import { createMockMeteoraExecutor } from "#modules/execution/clients";
import { MockPrivacyAdapter } from "#modules/execution/adapters";
import { createIndexerService } from "#modules/indexer";
import { createMemoryRepositories, createMemoryReconciliationRepository } from "#test-kit/memory-db";

import { createPositionService } from "../position.service";

describe("orchestrator service", () => {
  let repos = createMemoryRepositories();

  beforeEach(() => {
    repos = createMemoryRepositories();
  });

  it("holds a signed add-liquidity request in indexing until the snapshot is reconciled", async () => {
    const positionId = "pos_1";

    await repos.positionRepo.createPosition({
      id: positionId,
      intentId: "intent_1",
      action: "add-liquidity",
      mode: "fast-private",
      state: "awaiting_signature",
      poolSlug: "sol-usdc",
      amount: "1.25",
    });
    await repos.positionRepo.createExecutionSession({
      id: "session_1",
      positionId,
      state: "awaiting_signature",
      failureStage: null,
    });
    await repos.activityRepo.createActivity({
      id: "activity_1",
      positionId,
      action: "add-liquidity",
      state: "awaiting_signature",
      headline: "Intent received",
      detail: "Queued a draft SOL / USDC position for signature review.",
      safeNextStep: "wait",
    });

    const service = createPositionService({
      ...repos,
      privacyAdapter: new MockPrivacyAdapter(),
      meteoraExecutor: createMockMeteoraExecutor(),
    });

    const result = await service.executeSignedIntent({
      positionId,
      signedMessage: "base64sig",
    });

    expect(result.position.state).toBe("indexing");
    expect(result.session.state).toBe("indexing");
    expect(result.position.statusLabel).toBe("Verifying final position state");
    expect(result.activity.map((item) => item.state)).toEqual([
      "awaiting_signature",
      "funding_in_progress",
      "executing_on_meteora",
      "indexing",
    ]);

    const reconciled = await service.getPosition(positionId);

    expect(reconciled.position.state).toBe("active");
    expect(reconciled.session.state).toBe("active");
    expect(reconciled.position.statusLabel).toBe("Position active");
  });

  it("surfaces indexing lag recovery guidance while the final snapshot is missing", async () => {
    const positionId = "pos_2";

    await repos.positionRepo.createPosition({
      id: positionId,
      intentId: "intent_2",
      action: "add-liquidity",
      mode: "fast-private",
      state: "indexing",
      poolSlug: "sol-usdc",
      amount: "1.25",
    });
    await repos.positionRepo.createExecutionSession({
      id: "session_2",
      positionId,
      state: "indexing",
      failureStage: null,
    });
    await repos.activityRepo.createActivity({
      id: "activity_2",
      positionId,
      action: "add-liquidity",
      state: "indexing",
      headline: "Verifying final position state",
      detail: "Meteora returned signature-1; Octora is checking the final position state before activating it.",
      safeNextStep: "wait",
    });

    const service = createPositionService({
      ...repos,
      positionIndexer: {
        beginReconciliation: async () => ({ state: "indexing", statusLabel: "Verifying final position state", nextStep: "wait" }),
        registerSnapshot: async () => undefined,
        reconcile: async () => ({ state: "indexing", statusLabel: "Execution delayed", nextStep: "refresh" }),
      },
    });

    const result = await service.getPosition(positionId);

    expect(result.position.state).toBe("indexing");
    expect(result.position.statusLabel).toBe("Execution delayed");
    expect(result.recovery?.headline).toBe("Still waiting on the final snapshot");
    expect(result.activity.at(-1)?.recovery?.safeNextStep).toBe("refresh");
  });

  it("recovers indexing after the process-level indexer is recreated", async () => {
    const positionId = "pos_3";

    await repos.positionRepo.createPosition({
      id: positionId,
      intentId: "intent_3",
      action: "add-liquidity",
      mode: "fast-private",
      state: "awaiting_signature",
      poolSlug: "sol-usdc",
      amount: "1.25",
    });
    await repos.positionRepo.createExecutionSession({
      id: "session_3",
      positionId,
      state: "awaiting_signature",
      failureStage: null,
    });
    await repos.activityRepo.createActivity({
      id: "activity_3",
      positionId,
      action: "add-liquidity",
      state: "awaiting_signature",
      headline: "Intent received",
      detail: "Queued a draft SOL / USDC position for signature review.",
      safeNextStep: "wait",
    });

    const reconciliationRepo = createMemoryReconciliationRepository();
    const firstIndexer = createIndexerService({ store: reconciliationRepo });
    const firstService = createPositionService({
      ...repos,
      privacyAdapter: new MockPrivacyAdapter(),
      meteoraExecutor: createMockMeteoraExecutor(),
      positionIndexer: firstIndexer,
    });

    const indexing = await firstService.executeSignedIntent({
      positionId,
      signedMessage: "base64sig",
    });

    expect(indexing.position.state).toBe("indexing");

    const secondIndexer = createIndexerService({ store: reconciliationRepo });
    const secondService = createPositionService({
      ...repos,
      positionIndexer: secondIndexer,
    });

    const reconciled = await secondService.getPosition(positionId);

    expect(reconciled.position.state).toBe("active");
    expect(reconciled.session.state).toBe("active");
    expect(reconciled.position.statusLabel).toBe("Position active");
  });
});
