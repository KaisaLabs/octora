/**
 * Test plan IDs covered:
 *   API-POS-029a (new) executing > 5min with confirmed sig → advance to indexing
 *   API-POS-029b (new) executing > 5min with no sig → fail with venue-confirmation
 *   API-POS-029c (new) indexing > 2min reconciles to active → advance
 *   API-POS-029d (new) newly-failed positions trigger Sentry capture exactly once
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryRepositories } from "#test-kit/memory-db";
import { createActivityService } from "../activity.service";
import { createRecoveryWorker } from "#workers/recovery.worker";

import type { PositionIndexer } from "#modules/indexer";
import type { ReconciliationRepository } from "#modules/indexer/indexer.repository";
import type { SolanaChain } from "#common/solana/chain";

const TEST_WALLET = "TestWallet111111111111111111111111111111111";

function makeFakeChain(opts: {
  status: "confirmed" | "finalized" | "processed" | "missing" | "errored";
}): SolanaChain {
  return {
    async getSignatureStatus() {
      if (opts.status === "missing") return null;
      if (opts.status === "errored") {
        return {
          err: { InstructionError: [0, "Custom"] },
          slot: 1,
          confirmations: null,
          confirmationStatus: "confirmed" as const,
        };
      }
      return {
        err: null,
        slot: 1,
        confirmations: null,
        confirmationStatus: opts.status,
      };
    },
  } as unknown as SolanaChain;
}

function makeFakeIndexer(active: boolean): PositionIndexer {
  return {
    async beginReconciliation() {
      return { state: "indexing" as const, statusLabel: "x", nextStep: "wait" as const };
    },
    async registerSnapshot() {
      // noop
    },
    async reconcile() {
      return active
        ? { state: "active" as const, statusLabel: "Active", nextStep: "wait" as const }
        : { state: "indexing" as const, statusLabel: "x", nextStep: "wait" as const };
    },
  };
}

function makeFakeReconciliationRepo(signature: string | null): ReconciliationRepository {
  return {
    async load() {
      return signature === null ? null : { positionId: "any", signature };
    },
    async save() {
      throw new Error("not used in this test");
    },
    async clear() {
      // noop
    },
  };
}

describe("recovery worker", () => {
  let repos: ReturnType<typeof createMemoryRepositories>;

  beforeEach(() => {
    repos = createMemoryRepositories();
  });

  it("API-POS-029a: confirmed venue tx advances stuck `executing_on_meteora` → `indexing`", async () => {
    const created = await repos.positionRepo.createPosition({
      id: "pos_1",
      intentId: "intent_1",
      walletAddress: TEST_WALLET,
      action: "add-liquidity",
      mode: "fast-private",
      state: "executing_on_meteora",
      poolSlug: "sol-usdc",
      amount: "1",
    });
    await repos.positionRepo.createExecutionSession({
      id: "session_1",
      positionId: created.id,
      state: "executing_on_meteora",
    });

    // Force the row's updatedAt back 6 minutes so it qualifies as stuck.
    repos.positionRepo
      .getPositionById(created.id)
      .then((p) => p && ((p.updatedAt as Date).setTime(Date.now() - 6 * 60 * 1000)));

    const worker = createRecoveryWorker({
      positionRepo: repos.positionRepo,
      activityService: createActivityService(repos.activityRepo),
      positionIndexer: makeFakeIndexer(false),
      chain: makeFakeChain({ status: "confirmed" }),
      reconciliationRepo: makeFakeReconciliationRepo("real_sig"),
      log: () => {},
    });

    const result = await worker.tick(new Date());
    expect(result.executingAdvanced).toBe(1);
    const after = await repos.positionRepo.getPositionById(created.id);
    expect(after?.state).toBe("indexing");
  });

  it("API-POS-029b: stuck `executing_on_meteora` with no signature → fails with venue-confirmation", async () => {
    const created = await repos.positionRepo.createPosition({
      id: "pos_2",
      intentId: "intent_2",
      walletAddress: TEST_WALLET,
      action: "add-liquidity",
      mode: "fast-private",
      state: "executing_on_meteora",
      poolSlug: "sol-usdc",
      amount: "1",
    });
    await repos.positionRepo.createExecutionSession({
      id: "session_2",
      positionId: created.id,
      state: "executing_on_meteora",
    });
    const stuckRow = await repos.positionRepo.getPositionById(created.id);
    if (stuckRow) (stuckRow.updatedAt as Date).setTime(Date.now() - 6 * 60 * 1000);

    const worker = createRecoveryWorker({
      positionRepo: repos.positionRepo,
      activityService: createActivityService(repos.activityRepo),
      positionIndexer: makeFakeIndexer(false),
      chain: makeFakeChain({ status: "missing" }),
      reconciliationRepo: makeFakeReconciliationRepo(null),
      log: () => {},
    });

    const result = await worker.tick(new Date());
    expect(result.executingFailed).toBe(1);
    const after = await repos.positionRepo.getPositionById(created.id);
    expect(after?.state).toBe("failed");
  });

  it("API-POS-029c: stuck `indexing` reconciles to active when the indexer says so", async () => {
    const created = await repos.positionRepo.createPosition({
      id: "pos_3",
      intentId: "intent_3",
      walletAddress: TEST_WALLET,
      action: "add-liquidity",
      mode: "fast-private",
      state: "indexing",
      poolSlug: "sol-usdc",
      amount: "1",
    });
    await repos.positionRepo.createExecutionSession({
      id: "session_3",
      positionId: created.id,
      state: "indexing",
    });
    const stuckRow = await repos.positionRepo.getPositionById(created.id);
    if (stuckRow) (stuckRow.updatedAt as Date).setTime(Date.now() - 3 * 60 * 1000);

    const worker = createRecoveryWorker({
      positionRepo: repos.positionRepo,
      activityService: createActivityService(repos.activityRepo),
      positionIndexer: makeFakeIndexer(true),
      chain: makeFakeChain({ status: "confirmed" }),
      reconciliationRepo: makeFakeReconciliationRepo("ignored"),
      log: () => {},
    });

    const result = await worker.tick(new Date());
    expect(result.indexingAdvanced).toBe(1);
    const after = await repos.positionRepo.getPositionById(created.id);
    expect(after?.state).toBe("active");
  });

  it("API-POS-029d: newly-failed positions trigger captureException exactly once per tick window", async () => {
    const captured: Array<{ ctx: Record<string, unknown> | undefined }> = [];
    const capture = vi.fn((_err: unknown, ctx?: Record<string, unknown>) => {
      captured.push({ ctx });
    });

    const failed = await repos.positionRepo.createPosition({
      id: "pos_4",
      intentId: "intent_4",
      walletAddress: TEST_WALLET,
      action: "add-liquidity",
      mode: "fast-private",
      state: "failed",
      poolSlug: "sol-usdc",
      amount: "1",
    });
    // The in-memory store stamps a fixed historical date on every row;
    // bump updatedAt to "now" so it falls inside the worker's
    // lastFailureScan lookback window.
    const failedRow = await repos.positionRepo.getPositionById(failed.id);
    if (failedRow) (failedRow.updatedAt as Date).setTime(Date.now());

    const worker = createRecoveryWorker({
      positionRepo: repos.positionRepo,
      activityService: createActivityService(repos.activityRepo),
      positionIndexer: makeFakeIndexer(false),
      chain: makeFakeChain({ status: "confirmed" }),
      reconciliationRepo: makeFakeReconciliationRepo(null),
      captureException: capture,
      log: () => {},
    });

    // First tick — `failed` was created _before_ the worker's initial
    // `lastFailureScan` (which defaults to "now" at construction), so
    // the row sits at-or-after that boundary on the first scan only.
    const result = await worker.tick(new Date(Date.now() + 1000));
    expect(result.failuresAlerted).toBe(1);
    expect(captured[0]?.ctx?.positionId).toBe(failed.id);

    // Second tick — same row, no new failure → no duplicate page.
    const second = await worker.tick(new Date(Date.now() + 2000));
    expect(second.failuresAlerted).toBe(0);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
