/**
 * Private Position Close orchestrator + state machine (close/01, Flow 3
 * in CONTEXT-MAP.md).
 *
 * Pins the four mainline paths and each `*_FAILED` transition end-to-end
 * via the service composition root, plus the orchestrator's adapter
 * sequencing and the dust-threshold swap-skip decision.
 *
 * Pattern mirrors `deposit-lp.test.ts`: seed a Position at `active`,
 * drive the close service, assert state + status label transitions and
 * (where relevant) the activity-log trail.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createMemoryRepositories } from "#test-kit/memory-db";

import {
  createPositionService,
  CloseStateTransitionError,
  type CloseOrchestrationAdapter,
} from "../position.service";
import {
  CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS,
  createCloseService,
} from "../position.close.service";
import { createActivityService } from "../activity.service";

const WALLET = "TestWallet111111111111111111111111111111111";

interface SeedOpts {
  state?: string;
  positionId?: string;
}

async function seedActivePosition(
  repos: ReturnType<typeof createMemoryRepositories>,
  { state = "active", positionId = "pos_close" }: SeedOpts = {},
) {
  await repos.positionRepo.createPosition({
    id: positionId,
    intentId: `intent_${positionId}`,
    walletAddress: WALLET,
    action: "add-liquidity",
    mode: "fast-private",
    state,
    poolSlug: "sol-usdc",
    amount: "1.0",
  });
  await repos.positionRepo.createExecutionSession({
    id: `session_${positionId}`,
    positionId,
    state,
    failureStage: null,
  });
  await repos.activityRepo.createActivity({
    id: `activity_${positionId}`,
    positionId,
    action: "add-liquidity",
    state,
    headline: "Position active",
    detail: "Snapshot landed; the position is live.",
    safeNextStep: "wait",
  });
  return positionId;
}

/**
 * In-memory `CloseOrchestrationAdapter` for orchestrator tests. The
 * production wiring (Executor `dlmm_withdraw_close`, `dlmm_swap`,
 * relayer `mixer.deposit`) will swap in for this adapter; the unit
 * tests don't need a live RPC connection to exercise the state-machine
 * sequencing.
 */
function makeAdapter(opts: {
  residualLamports?: bigint;
  closeShouldFail?: boolean;
  swapShouldFail?: boolean;
  remixShouldFail?: boolean;
} = {}): { adapter: CloseOrchestrationAdapter; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    adapter: {
      async submitWithdrawClose() {
        calls.push("withdrawClose");
        if (opts.closeShouldFail) throw new Error("Meteora dropped the close tx");
        return {
          signature: "sig_close",
          otherSideResidualLamports: opts.residualLamports ?? 0n,
        };
      },
      async submitSwap() {
        calls.push("swap");
        if (opts.swapShouldFail) throw new Error("Swap route exhausted");
        return { signature: "sig_swap" };
      },
      async submitMixerDeposit() {
        calls.push("mixerDeposit");
        if (opts.remixShouldFail) throw new Error("Mixer pool paused");
        return { signature: "sig_mixer" };
      },
    },
  };
}

describe("Private Position Close — state-machine driver (close/01)", () => {
  let repos = createMemoryRepositories();

  beforeEach(() => {
    repos = createMemoryRepositories();
  });

  it("recordCloseSubmitted: active -> CLOSING", async () => {
    const positionId = await seedActivePosition(repos);
    const close = createCloseService({
      positionRepo: repos.positionRepo,
      activityService: serviceLikeActivity(repos),
    });
    const res = await close.recordCloseSubmitted(positionId);
    expect(res.position.state).toBe("CLOSING");
    expect(res.position.statusLabel).toBe("Closing position on Meteora");
  });

  it("recordCloseConfirmed routes through SWAPPING when residual exceeds dust threshold", async () => {
    const positionId = await seedActivePosition(repos);
    const close = createCloseService({
      positionRepo: repos.positionRepo,
      activityService: serviceLikeActivity(repos),
    });
    await close.recordCloseSubmitted(positionId);
    const { response, needsSwap } = await close.recordCloseConfirmed(
      positionId,
      CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS + 1n,
    );
    expect(needsSwap).toBe(true);
    expect(response.position.state).toBe("SWAPPING");
  });

  it("recordCloseConfirmed skips swap when residual is at or below the dust threshold", async () => {
    const positionId = await seedActivePosition(repos);
    const close = createCloseService({
      positionRepo: repos.positionRepo,
      activityService: serviceLikeActivity(repos),
    });
    await close.recordCloseSubmitted(positionId);
    const { response, needsSwap } = await close.recordCloseConfirmed(
      positionId,
      CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS,
    );
    expect(needsSwap).toBe(false);
    expect(response.position.state).toBe("REMIXING");
  });

  it("recordCloseConfirmed skips swap for single-sided SOL (residual == 0)", async () => {
    const positionId = await seedActivePosition(repos);
    const close = createCloseService({
      positionRepo: repos.positionRepo,
      activityService: serviceLikeActivity(repos),
    });
    await close.recordCloseSubmitted(positionId);
    const { needsSwap, response } = await close.recordCloseConfirmed(positionId, 0n);
    expect(needsSwap).toBe(false);
    expect(response.position.state).toBe("REMIXING");
    // The activity row should make the SOL-only reasoning explicit so
    // operators reading the audit log can tell why the swap step was
    // omitted.
    const latest = response.activity.at(-1);
    expect(latest?.detail).toMatch(/single-sided SOL/i);
  });

  it("rejects record*Confirmed methods called from the wrong source state", async () => {
    const positionId = await seedActivePosition(repos);
    const close = createCloseService({
      positionRepo: repos.positionRepo,
      activityService: serviceLikeActivity(repos),
    });
    // From `active`, cannot jump to REMIXING via recordSwapConfirmed
    // (that requires SWAPPING as the source).
    await expect(close.recordSwapConfirmed(positionId)).rejects.toBeInstanceOf(
      CloseStateTransitionError,
    );
    // From `active`, cannot jump to CLOSED via recordRemixConfirmed.
    await expect(close.recordRemixConfirmed(positionId)).rejects.toBeInstanceOf(
      CloseStateTransitionError,
    );
  });

  it("rejects record*Failed methods called from the wrong source state", async () => {
    const positionId = await seedActivePosition(repos);
    const close = createCloseService({
      positionRepo: repos.positionRepo,
      activityService: serviceLikeActivity(repos),
    });
    // active -> CLOSE_FAILED is not a permitted transition.
    await expect(close.recordCloseFailed(positionId, "test")).rejects.toBeInstanceOf(
      CloseStateTransitionError,
    );
  });
});

describe("Private Position Close — orchestrator (close/01)", () => {
  let repos = createMemoryRepositories();

  beforeEach(() => {
    repos = createMemoryRepositories();
  });

  it("happy path — SOL-only Position (no swap): CLOSING -> REMIXING -> CLOSED", async () => {
    const positionId = await seedActivePosition(repos);
    const { adapter, calls } = makeAdapter({ residualLamports: 0n });
    const service = createPositionService({ ...repos, closeAdapter: adapter });

    const res = await service.closePosition(positionId);
    expect(res.position.state).toBe("CLOSED");
    expect(res.position.statusLabel).toBe("Closed privately");
    expect(calls).toEqual(["withdrawClose", "mixerDeposit"]);

    const states = res.activity.map((a) => a.state);
    expect(states).toContain("CLOSING");
    expect(states).toContain("REMIXING");
    expect(states).toContain("CLOSED");
    expect(states).not.toContain("SWAPPING");
  });

  it("happy path — pair with non-SOL residual: CLOSING -> SWAPPING -> REMIXING -> CLOSED", async () => {
    const positionId = await seedActivePosition(repos);
    const { adapter, calls } = makeAdapter({
      residualLamports: CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS + 10n,
    });
    const service = createPositionService({ ...repos, closeAdapter: adapter });

    const res = await service.closePosition(positionId);
    expect(res.position.state).toBe("CLOSED");
    expect(calls).toEqual(["withdrawClose", "swap", "mixerDeposit"]);

    const states = res.activity.map((a) => a.state);
    expect(states).toEqual(
      expect.arrayContaining(["CLOSING", "SWAPPING", "REMIXING", "CLOSED"]),
    );
  });

  it("swap-skip — residual exactly at the dust threshold is left at the Stealth Wallet", async () => {
    const positionId = await seedActivePosition(repos);
    const { adapter, calls } = makeAdapter({
      residualLamports: CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS,
    });
    const service = createPositionService({ ...repos, closeAdapter: adapter });

    const res = await service.closePosition(positionId);
    expect(res.position.state).toBe("CLOSED");
    // No swap call — residual at-or-below threshold is dust per ADR-0003.
    expect(calls).toEqual(["withdrawClose", "mixerDeposit"]);
  });

  it("CLOSE_FAILED — dlmm_withdraw_close throw lands the matching terminal with Recovery Guidance", async () => {
    const positionId = await seedActivePosition(repos);
    const { adapter } = makeAdapter({ closeShouldFail: true });
    const service = createPositionService({ ...repos, closeAdapter: adapter });

    const res = await service.closePosition(positionId);
    expect(res.position.state).toBe("CLOSE_FAILED");
    expect(res.session.failureStage).toBe("close-submission");
    expect(res.recovery?.headline).toBe("Closing the position failed");
    expect(res.recovery?.safeNextStep).toBe("contact-support");
  });

  it("SWAP_FAILED — dlmm_swap throw lands the matching terminal with Recovery Guidance", async () => {
    const positionId = await seedActivePosition(repos);
    const { adapter } = makeAdapter({
      residualLamports: CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS + 1n,
      swapShouldFail: true,
    });
    const service = createPositionService({ ...repos, closeAdapter: adapter });

    const res = await service.closePosition(positionId);
    expect(res.position.state).toBe("SWAP_FAILED");
    expect(res.session.failureStage).toBe("swap-submission");
    expect(res.recovery?.headline).toBe("Swapping to SOL failed");
  });

  it("REMIX_FAILED — mixer.deposit throw lands the matching terminal with Recovery Guidance", async () => {
    const positionId = await seedActivePosition(repos);
    const { adapter } = makeAdapter({ remixShouldFail: true });
    const service = createPositionService({ ...repos, closeAdapter: adapter });

    const res = await service.closePosition(positionId);
    expect(res.position.state).toBe("REMIX_FAILED");
    expect(res.session.failureStage).toBe("remix-submission");
    expect(res.recovery?.headline).toBe("Re-mixing into the anonymity set failed");
  });

  it("rejects initiateClose from a non-active source state", async () => {
    const positionId = await seedActivePosition(repos, { state: "draft" });
    const { adapter } = makeAdapter();
    const service = createPositionService({ ...repos, closeAdapter: adapter });

    await expect(service.closePosition(positionId)).rejects.toBeInstanceOf(
      CloseStateTransitionError,
    );
  });
});

/**
 * Minimal `ActivityService` shape used by the close service for tests
 * that exercise the state-machine driver directly (no orchestrator).
 * Mirrors the `createActivityService(activityRepo)` wiring the
 * composition root uses; pulling it out here avoids re-importing the
 * factory inside every test block.
 */
function serviceLikeActivity(repos: ReturnType<typeof createMemoryRepositories>) {
  return createActivityService(repos.activityRepo);
}
