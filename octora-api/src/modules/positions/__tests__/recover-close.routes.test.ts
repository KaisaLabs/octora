/**
 * Route-level tests for `POST /positions/:positionId/close-recover` —
 * the close/03 reporting endpoint the browser hits after broadcasting
 * a user-signed close-recovery tx. Pins:
 *   - 200 on CLOSE_FAILED -> CLOSED (complete-close)
 *   - 200 on SWAP_FAILED  -> WITHDRAWN (bail-to-withdrawn)
 *   - 409 (InvalidCloseRecoveryState) on any other source state
 *   - 403 when the authenticated wallet doesn't own the Position
 *   - 401 when no wallet is stamped (strictWalletStamper path)
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createTestApp, strictWalletStamper } from "#test-kit/route-harness";
import { createMemoryRepositories } from "#test-kit/memory-db";
import type { CloseOrchestrationAdapter } from "../position.service";

// Both owner and other must be valid base58 Solana pubkeys — see
// recover-funds.routes.test.ts for the rationale.
const OWNER = "11111111111111111111111111111111";
const OTHER = "So11111111111111111111111111111111111111112";

/**
 * Close adapter whose every leg fails. Used to drive a fresh Position
 * from `active` through the close orchestrator into the matching
 * `*_FAILED` terminal via the live close route — no reaching into
 * private repo state from the route test.
 */
function makeFailingAdapter(opts: {
  closeFail?: boolean;
  swapFail?: boolean;
  remixFail?: boolean;
  residualLamports?: bigint;
}): CloseOrchestrationAdapter {
  return {
    async submitWithdrawClose() {
      if (opts.closeFail) throw new Error("close failed");
      return {
        signature: "sig_close",
        otherSideResidualLamports: opts.residualLamports ?? 0n,
      };
    },
    async submitSwap() {
      if (opts.swapFail) throw new Error("swap failed");
      return { signature: "sig_swap" };
    },
    async submitMixerDeposit() {
      if (opts.remixFail) throw new Error("remix failed");
      return { signature: "sig_mixer" };
    },
  };
}

async function seedActivePosition(
  repos: ReturnType<typeof createMemoryRepositories>,
  positionId: string,
  wallet: string,
): Promise<void> {
  await repos.positionRepo.createPosition({
    id: positionId,
    intentId: `intent_${positionId}`,
    walletAddress: wallet,
    action: "add-liquidity",
    mode: "fast-private",
    state: "active",
    poolSlug: "sol-usdc",
    amount: "1",
  });
  await repos.positionRepo.createExecutionSession({
    id: `session_${positionId}`,
    positionId,
    state: "active",
    failureStage: null,
  });
  await repos.activityRepo.createActivity({
    id: `activity_${positionId}`,
    positionId,
    action: "add-liquidity",
    state: "active",
    headline: "Seeded",
    detail: "Test seed.",
    safeNextStep: "wait",
  });
}

describe("POST /positions/:id/close-recover", () => {
  let repos: ReturnType<typeof createMemoryRepositories>;

  beforeEach(() => {
    repos = createMemoryRepositories();
  });

  it("returns 200 and drives CLOSE_FAILED -> CLOSED (complete-close)", async () => {
    const positionId = "pos_close_failed_complete";
    await seedActivePosition(repos, positionId, OWNER);
    const app = await createTestApp({
      repos,
      closeAdapter: makeFailingAdapter({ closeFail: true }),
    });

    // Walk active -> CLOSE_FAILED via the live close route.
    const closeRes = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close`,
      headers: { "x-wallet-address": OWNER },
    });
    expect(closeRes.statusCode).toBe(200);
    expect((closeRes.json() as { position: { state: string } }).position.state).toBe(
      "CLOSE_FAILED",
    );

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close-recover`,
      headers: { "x-wallet-address": OWNER },
      payload: {
        recoveryAction: "complete-close",
        txSignature: "userSignedCloseSig",
        recipient: "FreshRecipient",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      position: { state: string };
      activity: Array<{ headline: string }>;
    };
    expect(body.position.state).toBe("CLOSED");
    expect(body.activity.map((a) => a.headline)).toContain(
      "User-signed close-recovery submitted",
    );
  });

  it("returns 200 and drives SWAP_FAILED -> WITHDRAWN (bail-to-withdrawn)", async () => {
    const positionId = "pos_swap_failed_bail";
    await seedActivePosition(repos, positionId, OWNER);
    const app = await createTestApp({
      repos,
      closeAdapter: makeFailingAdapter({
        swapFail: true,
        residualLamports: 10_000n,
      }),
    });

    const closeRes = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close`,
      headers: { "x-wallet-address": OWNER },
    });
    expect(closeRes.statusCode).toBe(200);
    expect((closeRes.json() as { position: { state: string } }).position.state).toBe(
      "SWAP_FAILED",
    );

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close-recover`,
      headers: { "x-wallet-address": OWNER },
      payload: { recoveryAction: "bail-to-withdrawn" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { position: { state: string } };
    expect(body.position.state).toBe("WITHDRAWN");
  });

  it("returns 409 InvalidCloseRecoveryState when the Position is not *_FAILED", async () => {
    const positionId = "pos_active_no_recover";
    await seedActivePosition(repos, positionId, OWNER);
    const app = await createTestApp({
      repos,
      closeAdapter: makeFailingAdapter({}),
    });

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close-recover`,
      headers: { "x-wallet-address": OWNER },
      payload: { recoveryAction: "complete-close" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as { error?: string };
    expect(body.error).toBe("InvalidCloseRecoveryState");
  });

  it("returns 403 when the authenticated wallet does not own the Position", async () => {
    const positionId = "pos_owner_check";
    await seedActivePosition(repos, positionId, OWNER);
    const app = await createTestApp({
      repos,
      closeAdapter: makeFailingAdapter({ closeFail: true }),
    });

    await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close`,
      headers: { "x-wallet-address": OWNER },
    });

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close-recover`,
      headers: { "x-wallet-address": OTHER },
      payload: { recoveryAction: "complete-close" },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe("POST /positions/:id/close-recover — auth", () => {
  it("returns 401 when no wallet is stamped (strict auth)", async () => {
    const app = await createTestApp({ authPreHandlers: [strictWalletStamper] });
    const res = await app.inject({
      method: "POST",
      url: "/positions/any-id/close-recover",
      payload: { recoveryAction: "complete-close" },
    });
    expect(res.statusCode).toBe(401);
  });
});
