import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PoolSummary } from "#modules/dlmm";

import {
  computeMinAmountOut,
  validateSwapIntent,
  SwapValidationError,
} from "../swap.service";

const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const TOKEN_BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const SOL_USDC_POOL = "POOL_SOL_USDC_111111111111111111111111111";
const SOL_JUP_POOL = "POOL_SOL_JUP_1111111111111111111111111111";
const JUP_USDC_POOL = "POOL_JUP_USDC_111111111111111111111111111";

function pool(opts: {
  address: string;
  tokenX: string;
  tokenY: string;
  tvl?: number;
}): PoolSummary {
  return {
    address: opts.address,
    name: `pool-${opts.address.slice(0, 6)}`,
    pair: `${opts.tokenX.slice(0, 4)}/${opts.tokenY.slice(0, 4)}`,
    tokenX: { mint: opts.tokenX, symbol: "X", decimals: 6 },
    tokenY: { mint: opts.tokenY, symbol: "Y", decimals: 6 },
    tvl: opts.tvl ?? 100_000,
    volume24h: 0,
    fees24h: 0,
    volumeByTf: {},
    feesByTf: {},
    apr: 0,
    feeBps: 25,
    binStep: 10,
    baseFee: 0,
    createdAt: 0,
    network: "mainnet",
  };
}

// Hoisted mock — every test in this file pulls the same `listPools` stub.
vi.mock("#modules/dlmm", async () => {
  const actual = await vi.importActual<object>("#modules/dlmm");
  return {
    ...actual,
    listPools: vi.fn(),
  };
});

import { listPools } from "#modules/dlmm";
const mockListPools = listPools as unknown as ReturnType<typeof vi.fn>;

describe("validateSwapIntent", () => {
  beforeEach(() => {
    mockListPools.mockReset();
  });

  it("returns null when target pool is SOL-quoted and no swap is provided", async () => {
    const result = await validateSwapIntent({
      swapEnabled: true,
      network: "mainnet",
      targetPool: pool({
        address: SOL_USDC_POOL,
        tokenX: TOKEN_USDC,
        tokenY: NATIVE_SOL_MINT,
      }),
      swap: null,
    });
    expect(result).toBeNull();
  });

  it("rejects when SOL-quoted target pool ALSO has a swap step (unnecessary)", async () => {
    await expect(
      validateSwapIntent({
        swapEnabled: true,
        network: "mainnet",
        targetPool: pool({
          address: SOL_USDC_POOL,
          tokenX: TOKEN_USDC,
          tokenY: NATIVE_SOL_MINT,
        }),
        swap: {
          sourcePoolAddress: SOL_JUP_POOL,
          minAmountOut: "100",
          swapForY: false,
        },
      }),
    ).rejects.toMatchObject({
      code: "swap_required_for_non_sol_pair",
    });
  });

  it("rejects when non-SOL pair has no swap step", async () => {
    await expect(
      validateSwapIntent({
        swapEnabled: true,
        network: "mainnet",
        targetPool: pool({
          address: JUP_USDC_POOL,
          tokenX: TOKEN_JUP,
          tokenY: TOKEN_USDC,
        }),
        swap: null,
      }),
    ).rejects.toBeInstanceOf(SwapValidationError);
  });

  it("rejects when feature flag is OFF for a non-SOL pair", async () => {
    await expect(
      validateSwapIntent({
        swapEnabled: false,
        network: "mainnet",
        targetPool: pool({
          address: JUP_USDC_POOL,
          tokenX: TOKEN_JUP,
          tokenY: TOKEN_USDC,
        }),
        swap: {
          sourcePoolAddress: SOL_JUP_POOL,
          minAmountOut: "100",
          swapForY: true,
        },
      }),
    ).rejects.toMatchObject({ code: "swap_disabled" });
  });

  it("rejects when swap source equals LP target", async () => {
    await expect(
      validateSwapIntent({
        swapEnabled: true,
        network: "mainnet",
        targetPool: pool({
          address: JUP_USDC_POOL,
          tokenX: TOKEN_JUP,
          tokenY: TOKEN_USDC,
        }),
        swap: {
          sourcePoolAddress: JUP_USDC_POOL,
          minAmountOut: "100",
          swapForY: true,
        },
      }),
    ).rejects.toMatchObject({ code: "swap_source_equals_target" });
  });

  it("rejects when minAmountOut is zero", async () => {
    await expect(
      validateSwapIntent({
        swapEnabled: true,
        network: "mainnet",
        targetPool: pool({
          address: JUP_USDC_POOL,
          tokenX: TOKEN_JUP,
          tokenY: TOKEN_USDC,
        }),
        swap: {
          sourcePoolAddress: SOL_JUP_POOL,
          minAmountOut: "0",
          swapForY: true,
        },
      }),
    ).rejects.toMatchObject({ code: "swap_min_out_invalid" });
  });

  it("rejects when source pool not present in indexer", async () => {
    mockListPools.mockResolvedValue({
      data: [],
      total: 0,
      pages: 0,
      currentPage: 1,
      pageSize: 200,
    });
    await expect(
      validateSwapIntent({
        swapEnabled: true,
        network: "mainnet",
        targetPool: pool({
          address: JUP_USDC_POOL,
          tokenX: TOKEN_JUP,
          tokenY: TOKEN_USDC,
        }),
        swap: {
          sourcePoolAddress: SOL_JUP_POOL,
          minAmountOut: "100",
          swapForY: true,
        },
      }),
    ).rejects.toMatchObject({ code: "swap_source_unknown" });
  });

  it("accepts a valid SOL-paired source for a non-SOL target", async () => {
    mockListPools.mockResolvedValue({
      data: [
        pool({
          address: SOL_JUP_POOL,
          tokenX: NATIVE_SOL_MINT,
          tokenY: TOKEN_JUP,
          tvl: 1_000_000,
        }),
      ],
      total: 1,
      pages: 1,
      currentPage: 1,
      pageSize: 200,
    });
    const result = await validateSwapIntent({
      swapEnabled: true,
      network: "mainnet",
      targetPool: pool({
        address: JUP_USDC_POOL,
        tokenX: TOKEN_JUP,
        tokenY: TOKEN_USDC,
      }),
      swap: {
        sourcePoolAddress: SOL_JUP_POOL,
        minAmountOut: "1000",
        swapForY: false,
      },
    });
    expect(result).not.toBeNull();
    expect(result!.sourcePool.address).toBe(SOL_JUP_POOL);
    expect(result!.minAmountOut).toBe(1000n);
    expect(result!.swapForY).toBe(false);
  });

  it("rejects a source pool that doesn't pair against SOL even if returned by candidate filter", async () => {
    // Forcibly inject a pool that doesn't include SOL — the safety check
    // should catch it independent of the upstream filter.
    mockListPools.mockResolvedValue({
      data: [
        pool({
          address: SOL_JUP_POOL,
          tokenX: TOKEN_BONK,
          tokenY: TOKEN_JUP,
          tvl: 1_000_000,
        }),
      ],
      total: 1,
      pages: 1,
      currentPage: 1,
      pageSize: 200,
    });
    await expect(
      validateSwapIntent({
        swapEnabled: true,
        network: "mainnet",
        targetPool: pool({
          address: JUP_USDC_POOL,
          tokenX: TOKEN_JUP,
          tokenY: TOKEN_USDC,
        }),
        swap: {
          sourcePoolAddress: SOL_JUP_POOL,
          minAmountOut: "1000",
          swapForY: false,
        },
      }),
    ).rejects.toMatchObject({ code: "swap_source_unknown" });
  });
});

describe("computeMinAmountOut", () => {
  it("applies basis-point slippage", () => {
    expect(computeMinAmountOut(10_000n, 0)).toBe(10_000n); // 0% slippage
    expect(computeMinAmountOut(10_000n, 50)).toBe(9_950n); // 0.5%
    expect(computeMinAmountOut(10_000n, 100)).toBe(9_900n); // 1%
    expect(computeMinAmountOut(10_000n, 500)).toBe(9_500n); // 5%
  });

  it("caps slippage at 20%", () => {
    expect(computeMinAmountOut(10_000n, 5_000)).toBe(8_000n); // would be 50% → capped
  });

  it("rejects negative slippage", () => {
    expect(() => computeMinAmountOut(10_000n, -1)).toThrow(SwapValidationError);
  });
});
