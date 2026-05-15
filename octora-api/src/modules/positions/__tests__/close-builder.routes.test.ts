/**
 * Route-level tests for `POST /positions/:positionId/close-builder` —
 * the close/06 endpoint the user-signed close-recovery orchestrator
 * hits to assemble unsigned txs the browser stealth-keypair signs.
 *
 * Load-bearing assertions:
 *   - 200 with `{ transaction, leg }` when the chain is wired
 *   - 501 (CloseBuilderUnavailable) when no chain is injected — surfaces
 *     a typed error so the browser orchestrator can suggest the bail path
 *   - 403 when the authenticated wallet doesn't own the Position
 *   - The route never reaches `/relayer/*` (it's a tx builder, not a
 *     signer) — implicit by construction; pinned at the frontend test.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createTestApp } from "#test-kit/route-harness";
import { createMemoryRepositories } from "#test-kit/memory-db";
import { ScriptedChain } from "#common/solana/scripted-chain";

const OWNER = "11111111111111111111111111111111";
const OTHER = "So11111111111111111111111111111111111111112";
const STEALTH = "So11111111111111111111111111111111111111112";

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
}

function makeScriptedChain(): ScriptedChain {
  return new ScriptedChain({
    blockhash: {
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100,
    },
  });
}

describe("POST /positions/:id/close-builder", () => {
  let repos: ReturnType<typeof createMemoryRepositories>;

  beforeEach(() => {
    repos = createMemoryRepositories();
  });

  it("returns 200 with a base64 unsigned tx for the withdraw-close leg", async () => {
    const positionId = "pos_builder_withdraw_close";
    await seedActivePosition(repos, positionId, OWNER);
    const chain = makeScriptedChain();
    const app = await createTestApp({ repos, closeBuilderChain: chain });

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close-builder`,
      headers: { "x-wallet-address": OWNER },
      payload: {
        leg: "withdraw-close",
        signer: STEALTH,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { transaction: string; leg: string };
    expect(body.leg).toBe("withdraw-close");
    expect(typeof body.transaction).toBe("string");
    expect(body.transaction.length).toBeGreaterThan(0);
  });

  it("computes minAmountOutLamports for the swap leg from slippage + expected-out", async () => {
    const positionId = "pos_builder_swap";
    await seedActivePosition(repos, positionId, OWNER);
    const chain = makeScriptedChain();
    const app = await createTestApp({ repos, closeBuilderChain: chain });

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close-builder`,
      headers: { "x-wallet-address": OWNER },
      payload: {
        leg: "swap",
        signer: STEALTH,
        slippageBps: 50, // 0.5 %
        expectedSwapOutLamports: "1000000000",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      transaction: string;
      leg: string;
      minAmountOutLamports?: string;
    };
    // 1_000_000_000 * (10_000 − 50) / 10_000 = 995_000_000.
    expect(body.minAmountOutLamports).toBe("995000000");
  });

  it("returns 501 CloseBuilderUnavailable when no chain is wired", async () => {
    const positionId = "pos_builder_unwired";
    await seedActivePosition(repos, positionId, OWNER);
    // No closeBuilderChain — production-path miss simulated via `null`.
    const app = await createTestApp({ repos, closeBuilderChain: null });

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close-builder`,
      headers: { "x-wallet-address": OWNER },
      payload: { leg: "withdraw-close", signer: STEALTH },
    });

    expect(res.statusCode).toBe(501);
    const body = res.json() as { error?: string };
    expect(body.error).toBe("CloseBuilderUnavailable");
  });

  it("returns 403 when the authenticated wallet does not own the Position", async () => {
    const positionId = "pos_builder_owner_check";
    await seedActivePosition(repos, positionId, OWNER);
    const chain = makeScriptedChain();
    const app = await createTestApp({ repos, closeBuilderChain: chain });

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close-builder`,
      headers: { "x-wallet-address": OTHER },
      payload: { leg: "withdraw-close", signer: STEALTH },
    });

    expect(res.statusCode).toBe(403);
  });

  it("rejects invalid expectedSwapOutLamports with 400 (schema)", async () => {
    const positionId = "pos_builder_bad_expected";
    await seedActivePosition(repos, positionId, OWNER);
    const chain = makeScriptedChain();
    const app = await createTestApp({ repos, closeBuilderChain: chain });

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close-builder`,
      headers: { "x-wallet-address": OWNER },
      payload: {
        leg: "swap",
        signer: STEALTH,
        slippageBps: 50,
        expectedSwapOutLamports: "not-a-number",
      },
    });

    // Pattern violation gets caught at the schema layer; Fastify maps
    // to 400 by default (the close/02 422 mapping only applies on
    // controller-level catches, not schema rejections).
    expect([400, 422]).toContain(res.statusCode);
  });
});
