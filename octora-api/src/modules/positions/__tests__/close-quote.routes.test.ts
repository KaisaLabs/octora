/**
 * Route-level contract for close/02:
 *   - `GET  /positions/:positionId/close-quote` — pre-flight quote
 *   - `POST /positions/:positionId/close` — body extended with
 *     `{ slippageBps, expectedSwapOutLamports }`, threaded through to
 *     the swap adapter
 *
 * Pairs with `close-quote.test.ts` (service-level shape) and
 * `close-flow.routes.test.ts` (close/01's POST contract); together they
 * cover the full close/02 surface.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createTestApp } from "#test-kit/route-harness";
import { createMemoryRepositories } from "#test-kit/memory-db";

import type {
  CloseOrchestrationAdapter,
  CloseQuoteAdapter,
} from "../position.service";
import { CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS } from "../position.close.service";

const WALLET = "11111111111111111111111111111111";

async function seedPosition(
  repos: ReturnType<typeof createMemoryRepositories>,
  state: string,
): Promise<string> {
  const positionId = `pos_close_quote_${state}`;
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
    headline: "Seeded",
    detail: "Test seed.",
    safeNextStep: "wait",
  });
  return positionId;
}

function makeQuoteAdapter(opts: {
  withSwap?: boolean;
  unsupported?: boolean;
} = {}): CloseQuoteAdapter {
  return {
    async readPostCloseBalances() {
      return {
        solLamports: 1_000_000_000n,
        otherSideLamports: opts.withSwap ? 1_000_000n : 0n,
        otherSideSymbol: opts.withSwap ? "USDC" : null,
        otherSideMint: opts.withSwap ? "USDC11111111111111111111111111111111111111" : null,
        accruedFeeSolLamports: 0n,
        accruedFeeOtherLamports: 0n,
      };
    },
    async computeSwapOut() {
      return {
        expectedOutLamports: 300_000_000n,
        feeLamports: 900_000n,
        priceImpact: "0.0089",
      };
    },
    async assertMintSupported() {
      if (opts.unsupported) {
        const err = new Error("Mint MockX carries an unsupported Token-2022 extension (TransferHook)");
        err.name = "UnsupportedMintExtensionError";
        (err as any).details = {
          mint: "MockMint11111111111111111111111111111111111",
          extension: "TransferHook",
        };
        throw err;
      }
    },
    async resolveDenomination() {
      return 1_000_000_000n;
    },
  };
}

/**
 * Close orchestration adapter that captures the `submitSwap` args so
 * tests can assert slippage threading reached the swap leg, and
 * optionally fails the swap when the realized output undercuts
 * `min_amount_out` (the SWAP_FAILED scenario the ticket calls out).
 */
function makeCloseAdapter(opts: { realizedOutLamports?: bigint } = {}): {
  adapter: CloseOrchestrationAdapter;
  swapCalls: Array<{
    positionId: string;
    residualLamports: bigint;
    slippageBps: number;
    expectedOutLamports: bigint | null;
  }>;
} {
  const swapCalls: Array<{
    positionId: string;
    residualLamports: bigint;
    slippageBps: number;
    expectedOutLamports: bigint | null;
  }> = [];
  return {
    swapCalls,
    adapter: {
      async submitWithdrawClose() {
        return {
          signature: "sig_close",
          // Match the quote-adapter so the orchestrator's swap-step decision
          // exercises the path the test is asserting (above-dust → swap fires).
          otherSideResidualLamports: CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS + 1n,
        };
      },
      async submitSwap(input) {
        swapCalls.push({ ...input });
        // Mirror the on-chain `dlmm_swap` min_amount_out semantics: when
        // realized output is below the computed min, the ix reverts.
        if (input.expectedOutLamports !== null) {
          const minOut =
            (input.expectedOutLamports * BigInt(10_000 - input.slippageBps)) / 10_000n;
          const realized = opts.realizedOutLamports ?? input.expectedOutLamports;
          if (realized < minOut) {
            throw new Error(
              `dlmm_swap reverted: realized ${realized} < min_amount_out ${minOut}`,
            );
          }
        }
        return { signature: "sig_swap" };
      },
      async submitMixerDeposit() {
        return { signature: "sig_mixer" };
      },
    },
  };
}

describe("GET /positions/:positionId/close-quote (close/02)", () => {
  let repos: ReturnType<typeof createMemoryRepositories>;
  let app: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    repos = createMemoryRepositories();
  });

  it("returns SOL-only shape (no swap field) with denomination + dust", async () => {
    app = await createTestApp({ repos, closeQuoteAdapter: makeQuoteAdapter() });
    const positionId = await seedPosition(repos, "active");

    const res = await app.inject({
      method: "GET",
      url: `/positions/${positionId}/close-quote`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      closeable: boolean;
      swap?: unknown;
      denomination: string;
      dustLamports: string;
      estimate: { solLamports: string };
    };
    expect(body.closeable).toBe(true);
    expect(body.swap).toBeUndefined();
    expect(body.denomination).toBe("1000000000");
    expect(body.estimate.solLamports).toBe("1000000000");
  });

  it("returns SOL+other shape (with swap preview)", async () => {
    app = await createTestApp({
      repos,
      closeQuoteAdapter: makeQuoteAdapter({ withSwap: true }),
    });
    const positionId = await seedPosition(repos, "active");

    const res = await app.inject({
      method: "GET",
      url: `/positions/${positionId}/close-quote`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      closeable: boolean;
      swap?: { expectedOutLamports: string; priceImpact: string };
    };
    expect(body.closeable).toBe(true);
    expect(body.swap).toBeDefined();
    expect(body.swap?.expectedOutLamports).toBe("300000000");
    expect(body.swap?.priceImpact).toBe("0.0089");
  });

  it("reshapes UnsupportedMintExtensionError to closeable=false", async () => {
    app = await createTestApp({
      repos,
      closeQuoteAdapter: makeQuoteAdapter({ unsupported: true }),
    });
    const positionId = await seedPosition(repos, "active");

    const res = await app.inject({
      method: "GET",
      url: `/positions/${positionId}/close-quote`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      closeable: boolean;
      reason?: string;
      details?: { extension?: string };
    };
    expect(body.closeable).toBe(false);
    expect(body.reason).toBe("unsupported_mint");
    expect(body.details?.extension).toBe("TransferHook");
  });

  it("404s when the Position does not exist", async () => {
    app = await createTestApp({ repos, closeQuoteAdapter: makeQuoteAdapter() });
    const res = await app.inject({
      method: "GET",
      url: `/positions/does_not_exist/close-quote`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /positions/:positionId/close — slippageBps body (close/02)", () => {
  let repos: ReturnType<typeof createMemoryRepositories>;

  beforeEach(() => {
    repos = createMemoryRepositories();
  });

  it("accepts slippageBps + expectedSwapOutLamports and threads them into the swap adapter", async () => {
    const close = makeCloseAdapter();
    const app = await createTestApp({ repos, closeAdapter: close.adapter });
    const positionId = await seedPosition(repos, "active");

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close`,
      headers: { "x-wallet-address": WALLET },
      payload: { slippageBps: 100, expectedSwapOutLamports: "300000000" },
    });
    expect(res.statusCode).toBe(200);
    expect(close.swapCalls.length).toBe(1);
    expect(close.swapCalls[0]!.slippageBps).toBe(100);
    expect(close.swapCalls[0]!.expectedOutLamports).toBe(300_000_000n);
  });

  it("defaults to DEFAULT_CLOSE_SLIPPAGE_BPS (50) when slippageBps omitted", async () => {
    const close = makeCloseAdapter();
    const app = await createTestApp({ repos, closeAdapter: close.adapter });
    const positionId = await seedPosition(repos, "active");

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close`,
      headers: { "x-wallet-address": WALLET },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(close.swapCalls[0]!.slippageBps).toBe(50);
    expect(close.swapCalls[0]!.expectedOutLamports).toBeNull();
  });

  it("rejects slippageBps below 10 (out of range)", async () => {
    const close = makeCloseAdapter();
    const app = await createTestApp({ repos, closeAdapter: close.adapter });
    const positionId = await seedPosition(repos, "active");

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close`,
      headers: { "x-wallet-address": WALLET },
      payload: { slippageBps: 5 },
    });
    // Fastify/AJV validation failures land at 400 by default. The
    // project's `registerErrorHandler` maps them to 422 — pin the upper
    // range only (4xx) so the test doesn't couple to that detail.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("rejects slippageBps above 500 (out of range)", async () => {
    const close = makeCloseAdapter();
    const app = await createTestApp({ repos, closeAdapter: close.adapter });
    const positionId = await seedPosition(repos, "active");

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close`,
      headers: { "x-wallet-address": WALLET },
      payload: { slippageBps: 600 },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("lands in SWAP_FAILED when realized swap output undercuts min_amount_out", async () => {
    // Expected 300_000_000 lamports out, slippage 50 bps → min = 298_500_000.
    // Realized 290_000_000 < 298_500_000, so the in-memory adapter throws,
    // mirroring the on-chain `dlmm_swap` revert.
    const close = makeCloseAdapter({ realizedOutLamports: 290_000_000n });
    const app = await createTestApp({ repos, closeAdapter: close.adapter });
    const positionId = await seedPosition(repos, "active");

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/close`,
      headers: { "x-wallet-address": WALLET },
      payload: { slippageBps: 50, expectedSwapOutLamports: "300000000" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { position: { state: string }; session: { failureStage: string | null } };
    expect(body.position.state).toBe("SWAP_FAILED");
    expect(body.session.failureStage).toBe("swap-submission");
  });
});
