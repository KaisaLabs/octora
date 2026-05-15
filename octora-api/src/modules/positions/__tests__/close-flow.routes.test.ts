/**
 * Route-level contract for `POST /positions/:positionId/close` (close/01).
 *
 * Exercises the controller's 409 path (non-`active` source state) plus
 * a 200 happy path through the full app via the in-memory adapter. The
 * orchestrator's per-leg behaviour is covered in `close-flow.test.ts`;
 * this file just pins the HTTP contract.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createTestApp } from "#test-kit/route-harness";
import { createMemoryRepositories } from "#test-kit/memory-db";
import type { CloseOrchestrationAdapter } from "../position.service";

function makeAdapter(): CloseOrchestrationAdapter {
  return {
    async submitWithdrawClose() {
      return { signature: "sig_close", otherSideResidualLamports: 0n };
    },
    async submitSwap() {
      return { signature: "sig_swap" };
    },
    async submitMixerDeposit() {
      return { signature: "sig_mixer" };
    },
  };
}

const WALLET = "11111111111111111111111111111111";

async function seedPosition(
  repos: ReturnType<typeof createMemoryRepositories>,
  state: string,
): Promise<string> {
  const positionId = `pos_close_${state}`;
  await repos.positionRepo.createPosition({
    id: positionId,
    intentId: `intent_${positionId}`,
    walletAddress: WALLET,
    action: "add-liquidity",
    mode: "fast-private",
    state,
    poolSlug: "sol-usdc",
    amount: "1",
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
    headline: "Seeded",
    detail: "Test seed.",
    safeNextStep: "wait",
  });
  return positionId;
}

describe("POST /positions/:positionId/close", () => {
  let repos: ReturnType<typeof createMemoryRepositories>;
  let app: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    repos = createMemoryRepositories();
    app = await createTestApp({ repos, closeAdapter: makeAdapter() });
  });

  it("returns 200 with state=CLOSED when initiated from `active`", async () => {
    const positionId = await seedPosition(repos, "active");

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close`,
      headers: { "x-wallet-address": WALLET },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { position: { state: string; statusLabel: string } };
    expect(body.position.state).toBe("CLOSED");
    expect(body.position.statusLabel).toBe("Closed privately");
  });

  it("returns 409 when initiated from a non-active state (`draft`)", async () => {
    const positionId = await seedPosition(repos, "draft");

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close`,
      headers: { "x-wallet-address": WALLET },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe("StateTransitionRejected");
  });
});
