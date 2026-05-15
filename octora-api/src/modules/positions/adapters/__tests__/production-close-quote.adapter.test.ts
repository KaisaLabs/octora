/**
 * Production `CloseQuoteAdapter` (close/02) tests.
 *
 * Validates the production wiring:
 *   - Methods that need per-position context (`readPostCloseBalances`,
 *     `computeSwapOut`, `assertMintSupported`, `resolveDenomination`)
 *     throw `CloseQuoteWiringIncompleteError` until a context
 *     resolver is supplied.
 *   - When wired, `computeSwapOut` delegates to the live DLMM
 *     `getSwapQuote` (mocked here via the chain configurator).
 *   - `assertMintSupported` re-throws an `UnsupportedMintExtensionError`
 *     shaped to match what `close-quote.service` matches on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { configureDlmmChain } from "#modules/dlmm/dlmm.chain";

import {
  CloseQuoteWiringIncompleteError,
  createProductionCloseQuoteAdapter,
  type CloseQuotePositionContext,
} from "../production-close-quote.adapter";

// Stub the underlying SDK so getSwapQuote doesn't try to hit a real
// network. We patch `@meteora-ag/dlmm`'s `DLMM.create` to return a
// stub instance with the methods getSwapQuote depends on.
vi.mock("@meteora-ag/dlmm", () => {
  return {
    default: {
      create: vi.fn(async () => ({
        getBinArrayForSwap: async () => [],
        swapQuote: () => ({
          outAmount: { toString: () => "950000000" },
          minOutAmount: { toString: () => "900000000" },
          consumedInAmount: { toString: () => "1000000" },
          fee: { toString: () => "750000" },
          priceImpact: { toString: () => "0.0124" },
          endPrice: { toString: () => "1.0" },
        }),
      })),
    },
  };
});

function makeCtx(overrides: Partial<CloseQuotePositionContext> = {}): CloseQuotePositionContext {
  return {
    poolAddress: "8RKi3UYYbpgnTwJTjgPbpaJrqzKEafjLD8nuwHFGJVTo",
    network: "mainnet" as const,
    swapForY: true,
    postCloseBalances: {
      solLamports: 1_000_000_000n,
      otherSideLamports: 1_000_000n,
      otherSideSymbol: "USDC",
      otherSideMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      accruedFeeSolLamports: 5_000_000n,
      accruedFeeOtherLamports: 10_000n,
    },
    denomination: 1_000_000_000n,
    unsupportedMintExtension: null,
    ...overrides,
  };
}

beforeEach(() => {
  // Configure a no-op chain bag — the SDK stub doesn't actually use
  // the underlying Connection, but configureDlmmChain requires the
  // map to exist.
  configureDlmmChain({
    chains: {
      mainnet: { rawConnection: () => ({}) } as never,
      devnet: { rawConnection: () => ({}) } as never,
      localnet: { rawConnection: () => ({}) } as never,
    },
  });
});

describe("createProductionCloseQuoteAdapter — wiring-incomplete behaviour", () => {
  it("readPostCloseBalances throws when no resolver wired", async () => {
    const adapter = createProductionCloseQuoteAdapter({ positionRepo: {} as never });
    await expect(
      adapter.readPostCloseBalances({ positionId: "pos_x" }),
    ).rejects.toBeInstanceOf(CloseQuoteWiringIncompleteError);
  });

  it("computeSwapOut throws when no resolver wired", async () => {
    const adapter = createProductionCloseQuoteAdapter({ positionRepo: {} as never });
    await expect(
      adapter.computeSwapOut({ positionId: "pos_x", otherSideLamports: 1_000_000n }),
    ).rejects.toBeInstanceOf(CloseQuoteWiringIncompleteError);
  });
});

describe("createProductionCloseQuoteAdapter — wired behaviour", () => {
  it("computeSwapOut returns the live getSwapQuote numbers from the resolved context", async () => {
    const ctx = makeCtx();
    const adapter = createProductionCloseQuoteAdapter({
      positionRepo: {} as never,
      contextResolver: async () => ctx,
    });
    const result = await adapter.computeSwapOut({
      positionId: "pos_y",
      otherSideLamports: 1_000_000n,
    });
    expect(result.expectedOutLamports).toBe(950_000_000n);
    expect(result.feeLamports).toBe(750_000n);
    expect(result.priceImpact).toBe("0.0124");
  });

  it("readPostCloseBalances returns the resolved context's balance bundle", async () => {
    const ctx = makeCtx();
    const adapter = createProductionCloseQuoteAdapter({
      positionRepo: {} as never,
      contextResolver: async () => ctx,
    });
    const result = await adapter.readPostCloseBalances({ positionId: "pos_y2" });
    expect(result.solLamports).toBe(1_000_000_000n);
    expect(result.otherSideSymbol).toBe("USDC");
  });

  it("resolveDenomination passes through the resolved value (null surfaces close/05 caveat)", async () => {
    const adapter = createProductionCloseQuoteAdapter({
      positionRepo: {} as never,
      contextResolver: async () => makeCtx({ denomination: null }),
    });
    const result = await adapter.resolveDenomination({ positionId: "pos_y3" });
    expect(result).toBe(null);
  });

  it("assertMintSupported throws UnsupportedMintExtensionError-shaped error when context flags it", async () => {
    const adapter = createProductionCloseQuoteAdapter({
      positionRepo: {} as never,
      contextResolver: async () =>
        makeCtx({
          unsupportedMintExtension: {
            mint: "BadMint11111111111111111111111111111111111",
            extension: "TransferHook",
          },
        }),
    });
    try {
      await adapter.assertMintSupported({ positionId: "pos_blocked" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).name).toBe("UnsupportedMintExtensionError");
      expect((err as Error & { details: { extension: string } }).details.extension).toBe(
        "TransferHook",
      );
    }
  });

  it("assertMintSupported resolves silently when no extension flag is set", async () => {
    const adapter = createProductionCloseQuoteAdapter({
      positionRepo: {} as never,
      contextResolver: async () => makeCtx({ unsupportedMintExtension: null }),
    });
    await expect(
      adapter.assertMintSupported({ positionId: "pos_ok" }),
    ).resolves.toBeUndefined();
  });
});
