/**
 * Pre-flight close quote service (close/02).
 *
 * Pins the service-level contract:
 *   - SOL-only Position → no `swap` field
 *   - SOL+other Position with residual above the dust threshold → swap
 *     preview filled in with input/expectedOut/fee/priceImpact
 *   - Residual at-or-below dust threshold → swap omitted (matches the
 *     orchestrator's swap-skip rule)
 *   - close/04 mint precheck rejection → reshaped to
 *     `{ closeable: false, reason: "unsupported_mint", details }`
 *   - Dust math: `dustLamports = postSwapSol % denomination` when the
 *     denomination is known; `0` when it isn't (close/05 caveat).
 *
 * The service is adapter-shaped per close/01's precedent — every
 * on-chain read is mocked here so the unit tests don't need an RPC
 * connection.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { ValidationError } from "#common/errors";

import { createMemoryRepositories } from "#test-kit/memory-db";

import {
  createCloseQuoteService,
  type CloseQuoteAdapter,
  type CloseQuoteResponse,
} from "../position.close-quote.service";
import { CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS } from "../position.close.service";

const POSITION_ID = "pos_close_quote";

async function seedActivePosition(
  repos: ReturnType<typeof createMemoryRepositories>,
): Promise<void> {
  await repos.positionRepo.createPosition({
    id: POSITION_ID,
    intentId: `intent_${POSITION_ID}`,
    walletAddress: "11111111111111111111111111111111",
    action: "add-liquidity",
    mode: "fast-private",
    state: "active",
    poolSlug: "sol-usdc",
    amount: "1.0",
  });
  await repos.positionRepo.createExecutionSession({
    id: `session_${POSITION_ID}`,
    positionId: POSITION_ID,
    state: "active",
    failureStage: null,
  });
}

/**
 * Same shape as the in-memory adapter `position.service.ts`'s
 * production wiring will eventually replace. Returns canned numbers so
 * the test reads on a single screen.
 */
interface AdapterOpts {
  solLamports?: bigint;
  otherSideLamports?: bigint;
  otherSideSymbol?: string | null;
  otherSideMint?: string | null;
  accruedFeeSolLamports?: bigint;
  accruedFeeOtherLamports?: bigint;
  expectedSwapOutLamports?: bigint;
  feeLamports?: bigint;
  priceImpact?: string;
  denomination?: bigint | null;
  unsupportedExtension?:
    | "TransferHook"
    | "NonTransferable"
    | "ConfidentialTransferMint"
    | "PermanentDelegate";
  swapShouldThrow?: boolean;
}

function makeAdapter(opts: AdapterOpts = {}): CloseQuoteAdapter {
  return {
    async readPostCloseBalances() {
      return {
        solLamports: opts.solLamports ?? 1_000_000_000n,
        otherSideLamports: opts.otherSideLamports ?? 0n,
        otherSideSymbol: opts.otherSideSymbol ?? null,
        otherSideMint: opts.otherSideMint ?? null,
        accruedFeeSolLamports: opts.accruedFeeSolLamports ?? 0n,
        accruedFeeOtherLamports: opts.accruedFeeOtherLamports ?? 0n,
      };
    },
    async computeSwapOut() {
      if (opts.swapShouldThrow) {
        throw new Error("Pool exhausted in swap direction");
      }
      return {
        expectedOutLamports: opts.expectedSwapOutLamports ?? 250_000_000n,
        feeLamports: opts.feeLamports ?? 750_000n,
        priceImpact: opts.priceImpact ?? "0.0124",
      };
    },
    async assertMintSupported() {
      if (opts.unsupportedExtension) {
        // Mirror `UnsupportedMintExtensionError` shape without importing it
        // directly — keeps the test independent of the helper's module
        // path. The service matches on `err.name` + `details`.
        const err = new ValidationError(
          `Mint X carries an unsupported Token-2022 extension (${opts.unsupportedExtension})`,
          {
            code: "unsupported_mint_extension",
            details: {
              mint: "MockMint11111111111111111111111111111111111",
              extension: opts.unsupportedExtension,
            },
          },
        );
        err.name = "UnsupportedMintExtensionError";
        throw err;
      }
    },
    async resolveDenomination() {
      // Default to 1 SOL denomination so the dust math is deterministic.
      return opts.denomination === undefined ? 1_000_000_000n : opts.denomination;
    },
  };
}

describe("close/02 — close-quote service", () => {
  let repos = createMemoryRepositories();

  beforeEach(async () => {
    repos = createMemoryRepositories();
    await seedActivePosition(repos);
  });

  it("SOL-only Position: no swap field, dust math against denomination", async () => {
    const service = createCloseQuoteService({
      positionRepo: repos.positionRepo,
      adapter: makeAdapter({
        solLamports: 1_234_567_000n, // 1.234567 SOL
        otherSideLamports: 0n,
        denomination: 1_000_000_000n,
      }),
    });

    const quote = (await service.quote(POSITION_ID)) as Extract<
      CloseQuoteResponse,
      { closeable: true }
    >;
    expect(quote.closeable).toBe(true);
    expect(quote.swap).toBeUndefined();
    expect(quote.estimate.solLamports).toBe("1234567000");
    expect(quote.estimate.otherSideLamports).toBe("0");
    expect(quote.denomination).toBe("1000000000");
    // 1.234567 SOL minus 1 denomination = 234567000 lamports of sub-denom dust.
    expect(quote.dustLamports).toBe("234567000");
  });

  it("SOL+other above dust: swap field present with input/out/fee/priceImpact", async () => {
    const service = createCloseQuoteService({
      positionRepo: repos.positionRepo,
      adapter: makeAdapter({
        solLamports: 750_000_000n,
        otherSideLamports: 1_000_000n, // well above dust threshold
        otherSideSymbol: "USDC",
        expectedSwapOutLamports: 300_000_000n,
        feeLamports: 900_000n,
        priceImpact: "0.0089",
        denomination: 1_000_000_000n,
      }),
    });

    const quote = (await service.quote(POSITION_ID)) as Extract<
      CloseQuoteResponse,
      { closeable: true }
    >;
    expect(quote.closeable).toBe(true);
    expect(quote.swap).toEqual({
      inLamports: "1000000",
      expectedOutLamports: "300000000",
      feeLamports: "900000",
      priceImpact: "0.0089",
    });
    expect(quote.estimate.otherSideSymbol).toBe("USDC");
    // postSwapSol = 750_000_000 + 300_000_000 = 1_050_000_000
    // dust = postSwapSol % denomination = 50_000_000
    expect(quote.dustLamports).toBe("50000000");
  });

  it("residual exactly at the dust threshold: swap omitted (matches orchestrator skip rule)", async () => {
    const service = createCloseQuoteService({
      positionRepo: repos.positionRepo,
      adapter: makeAdapter({
        otherSideLamports: CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS,
        denomination: 1_000_000_000n,
      }),
    });

    const quote = (await service.quote(POSITION_ID)) as Extract<
      CloseQuoteResponse,
      { closeable: true }
    >;
    expect(quote.swap).toBeUndefined();
  });

  it("residual one lamport above the dust threshold: swap preview included", async () => {
    const service = createCloseQuoteService({
      positionRepo: repos.positionRepo,
      adapter: makeAdapter({
        otherSideLamports: CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS + 1n,
        denomination: 1_000_000_000n,
      }),
    });

    const quote = (await service.quote(POSITION_ID)) as Extract<
      CloseQuoteResponse,
      { closeable: true }
    >;
    expect(quote.swap).toBeDefined();
  });

  it("close/04 mint precheck rejection: reshapes to closeable=false unsupported_mint", async () => {
    const service = createCloseQuoteService({
      positionRepo: repos.positionRepo,
      adapter: makeAdapter({ unsupportedExtension: "TransferHook" }),
    });

    const quote = await service.quote(POSITION_ID);
    expect(quote.closeable).toBe(false);
    if (!quote.closeable) {
      expect(quote.reason).toBe("unsupported_mint");
      expect(quote.details.extension).toBe("TransferHook");
      expect(quote.details.mint).toBe(
        "MockMint11111111111111111111111111111111111",
      );
    }
  });

  it("denomination null (close/05 caveat): dustLamports defaults to 0 honestly", async () => {
    const service = createCloseQuoteService({
      positionRepo: repos.positionRepo,
      adapter: makeAdapter({
        solLamports: 1_234_567_000n,
        denomination: null,
      }),
    });

    const quote = (await service.quote(POSITION_ID)) as Extract<
      CloseQuoteResponse,
      { closeable: true }
    >;
    expect(quote.denomination).toBe("0");
    expect(quote.dustLamports).toBe("0");
  });

  it("rejects when constructed without an adapter (production-unwired path)", async () => {
    const service = createCloseQuoteService({ positionRepo: repos.positionRepo });
    await expect(service.quote(POSITION_ID)).rejects.toThrow(
      /createCloseQuoteService was constructed without an adapter/,
    );
  });
});
