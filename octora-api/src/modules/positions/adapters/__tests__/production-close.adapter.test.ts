/**
 * Production `CloseOrchestrationAdapter` (close/01) tests.
 *
 * Validates the production-wiring path:
 *   - When no `contextResolver` is wired, every method throws
 *     `CloseOrchestrationWiringIncompleteError` so production startups
 *     see a typed 503-equivalent rather than fabricated success.
 *   - When a resolver is wired, the adapter delegates to the executor
 *     client's `buildWithdrawCloseIx` / `buildSwapIx` with the
 *     correct context, and threads through the slippage-derived
 *     `min_amount_out`.
 *
 * Structural-mock approach per the ticket's fall-back: the executor
 * client + mixer service are mocked so the test doesn't need
 * surfpool. The ix-builder methods are real (proven by the executor
 * client unit tests); this test only pins the adapter's plumbing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";

import type { OctoraExecutorClient } from "#modules/execution/clients";

import {
  CloseOrchestrationWiringIncompleteError,
  createProductionCloseAdapter,
  type CloseOrchestrationPositionContext,
} from "../production-close.adapter";

function makeCtx(overrides: Partial<CloseOrchestrationPositionContext> = {}): CloseOrchestrationPositionContext {
  return {
    stealthKeypair: Keypair.generate(),
    positionPubkey: Keypair.generate().publicKey,
    lbPair: Keypair.generate().publicKey,
    withdrawCloseRemainingAccounts: Array.from({ length: 17 }, () => ({
      pubkey: Keypair.generate().publicKey,
      isSigner: false,
      isWritable: false,
    })),
    swapRemainingAccounts: Array.from({ length: 17 }, () => ({
      pubkey: Keypair.generate().publicKey,
      isSigner: false,
      isWritable: false,
    })),
    fromBinId: -10,
    toBinId: 10,
    remainingAccountsInfo: Buffer.from([0, 0, 0, 0]),
    denomination: 1_000_000_000n,
    remixCommitment: 1234567890n,
    ...overrides,
  };
}

function makeExecutorMock(): {
  client: OctoraExecutorClient;
  buildSwap: ReturnType<typeof vi.fn>;
  buildWithdraw: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const dummyIx: TransactionInstruction = new TransactionInstruction({
    keys: [],
    programId: new PublicKey("4n47TYP2hQ2bwS8GiU3a1EVyF9mgeSbKWBvAVmUjaUtK"),
    data: Buffer.alloc(8),
  });
  const buildWithdraw = vi.fn().mockResolvedValue(dummyIx);
  const buildSwap = vi.fn().mockResolvedValue(dummyIx);
  const send = vi.fn().mockResolvedValue("mock_sig_abc123");
  const client = {
    buildWithdrawCloseIx: buildWithdraw,
    buildSwapIx: buildSwap,
    sendIx: send,
  } as unknown as OctoraExecutorClient;
  return { client, buildSwap, buildWithdraw, send };
}

describe("createProductionCloseAdapter — wiring-incomplete behaviour", () => {
  it("submitWithdrawClose throws CloseOrchestrationWiringIncompleteError when no resolver", async () => {
    const { client } = makeExecutorMock();
    const adapter = createProductionCloseAdapter({
      executorClient: client,
      mixerServiceFor: () => ({} as never),
      chain: {} as never,
    });
    await expect(
      adapter.submitWithdrawClose({ positionId: "pos_x" }),
    ).rejects.toBeInstanceOf(CloseOrchestrationWiringIncompleteError);
  });

  it("submitSwap throws CloseOrchestrationWiringIncompleteError when no resolver", async () => {
    const { client } = makeExecutorMock();
    const adapter = createProductionCloseAdapter({
      executorClient: client,
      mixerServiceFor: () => ({} as never),
      chain: {} as never,
    });
    await expect(
      adapter.submitSwap({
        positionId: "pos_x",
        residualLamports: 1_000_000n,
        slippageBps: 50,
        expectedOutLamports: 990_000n,
      }),
    ).rejects.toBeInstanceOf(CloseOrchestrationWiringIncompleteError);
  });
});

describe("createProductionCloseAdapter — wired behaviour", () => {
  it("submitWithdrawClose builds + sends the dlmm_withdraw_close ix with the resolved context", async () => {
    const { client, buildWithdraw, send } = makeExecutorMock();
    const ctx = makeCtx();
    const adapter = createProductionCloseAdapter({
      executorClient: client,
      mixerServiceFor: () => ({} as never),
      chain: {} as never,
      contextResolver: async () => ctx,
    });
    const result = await adapter.submitWithdrawClose({ positionId: "pos_y" });

    expect(buildWithdraw).toHaveBeenCalledTimes(1);
    expect(buildWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({
        stealth: ctx.stealthKeypair.publicKey,
        lbPair: ctx.lbPair,
        fromBinId: ctx.fromBinId,
        toBinId: ctx.toBinId,
        bpsToRemove: 10_000,
      }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.signature).toBe("mock_sig_abc123");
    // Other-side residual reading is the documented scope-down (see
    // adapter source): returns 0n until the ATA pubkey field lands.
    expect(result.otherSideResidualLamports).toBe(0n);
  });

  it("submitSwap computes min_amount_out from slippage + expectedOut and threads it to buildSwapIx", async () => {
    const { client, buildSwap } = makeExecutorMock();
    const ctx = makeCtx();
    const adapter = createProductionCloseAdapter({
      executorClient: client,
      mixerServiceFor: () => ({} as never),
      chain: {} as never,
      contextResolver: async () => ctx,
    });

    await adapter.submitSwap({
      positionId: "pos_z",
      residualLamports: 1_000_000n,
      slippageBps: 50,
      expectedOutLamports: 1_000_000_000n,
    });

    expect(buildSwap).toHaveBeenCalledTimes(1);
    const call = buildSwap.mock.calls[0][0];
    expect(call.amountIn).toBe(1_000_000n);
    // 1_000_000_000 * (10_000 − 50) / 10_000 = 995_000_000
    expect(call.minAmountOut).toBe(995_000_000n);
    expect(call.stealth).toEqual(ctx.stealthKeypair.publicKey);
    expect(call.lbPair).toEqual(ctx.lbPair);
  });

  it("submitSwap falls back to min_out = 1 when no expectedOut is supplied (historical placeholder)", async () => {
    const { client, buildSwap } = makeExecutorMock();
    const ctx = makeCtx();
    const adapter = createProductionCloseAdapter({
      executorClient: client,
      mixerServiceFor: () => ({} as never),
      chain: {} as never,
      contextResolver: async () => ctx,
    });

    await adapter.submitSwap({
      positionId: "pos_z2",
      residualLamports: 1_000_000n,
      slippageBps: 50,
      expectedOutLamports: null,
    });

    const call = buildSwap.mock.calls[0][0];
    expect(call.minAmountOut).toBe(1n);
  });

  it("submitMixerDeposit surfaces a wiring-incomplete error until the relayer signer seam lands", async () => {
    const { client } = makeExecutorMock();
    const mockMixer = {
      buildDepositTransaction: vi.fn().mockResolvedValue({ transaction: "base64_unsigned_tx" }),
    };
    const ctx = makeCtx();
    const adapter = createProductionCloseAdapter({
      executorClient: client,
      mixerServiceFor: () => mockMixer as never,
      chain: {} as never,
      contextResolver: async () => ctx,
    });
    await expect(
      adapter.submitMixerDeposit({ positionId: "pos_z3" }),
    ).rejects.toBeInstanceOf(CloseOrchestrationWiringIncompleteError);
    // The adapter still builds the unsigned tx (proves the mixer
    // service plumbing is correct) before reporting the relayer-signer
    // gap.
    expect(mockMixer.buildDepositTransaction).toHaveBeenCalledTimes(1);
  });
});
