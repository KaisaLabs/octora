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
 *   - production-ix-wiring/02 — `submitWithdrawClose` reads the
 *     stealth's other-side ATA via the chain seam, and
 *     `submitMixerDeposit` signs + submits the unsigned tx with the
 *     stealth keypair.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import type { SolanaChain } from "#common/solana/chain";
import type { OctoraExecutorClient } from "#modules/execution/clients";

import {
  CloseOrchestrationWiringIncompleteError,
  createProductionCloseAdapter,
  type CloseOrchestrationPositionContext,
} from "../production-close.adapter";

function makeMockUnsignedDepositTx(depositor: PublicKey): string {
  const tx = new Transaction();
  tx.feePayer = depositor;
  // Real base58, 32 bytes — exact alphabet matters (no 0,O,I,l).
  tx.recentBlockhash = "11111111111111111111111111111112";
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(SystemProgram.transfer({ fromPubkey: depositor, toPubkey: depositor, lamports: 0 }));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

function makeMockChain(opts: { tokenAmount?: bigint; sendResult?: string } = {}): SolanaChain & {
  sentTx: { raw: Uint8Array } | null;
} {
  const buf = Buffer.alloc(165);
  if (opts.tokenAmount !== undefined) buf.writeBigUInt64LE(opts.tokenAmount, 64);
  let sentTx: { raw: Uint8Array } | null = null;
  const chain: SolanaChain = {
    async getAccountInfo() {
      return opts.tokenAmount === undefined
        ? null
        : {
            data: buf,
            executable: false,
            owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
            lamports: 2_039_280,
            rentEpoch: 0,
          };
    },
    async getBalance() { return 0; },
    async getLatestBlockhash() {
      return { blockhash: "11111111111111111111111111111113", lastValidBlockHeight: 1_000_000 };
    },
    async getSlot() { return 0; },
    async getSignatureStatus() { return null; },
    async getRecentPrioritizationFees() { return []; },
    async simulateTransaction() {
      return { err: null, logs: [], accounts: null, unitsConsumed: 0, returnData: null, innerInstructions: null };
    },
    async sendTransaction() { return opts.sendResult ?? "deposit_sig"; },
    anchorProvider() { throw new Error("not used"); },
    rawConnection() {
      return {
        sendRawTransaction: async (raw: Uint8Array) => {
          sentTx = { raw };
          return opts.sendResult ?? "deposit_sig";
        },
        confirmTransaction: async () => ({ value: { err: null } }),
      } as never;
    },
  };
  Object.defineProperty(chain, "sentTx", { get: () => sentTx });
  return chain as SolanaChain & { sentTx: { raw: Uint8Array } | null };
}

function makeCtx(
  overrides: Partial<CloseOrchestrationPositionContext> = {},
): CloseOrchestrationPositionContext {
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
    stealthOtherAta: null,
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
      chain: makeMockChain(),
    });
    await expect(adapter.submitWithdrawClose({ positionId: "pos_x" })).rejects.toBeInstanceOf(
      CloseOrchestrationWiringIncompleteError,
    );
  });

  it("submitSwap throws CloseOrchestrationWiringIncompleteError when no resolver", async () => {
    const { client } = makeExecutorMock();
    const adapter = createProductionCloseAdapter({
      executorClient: client,
      mixerServiceFor: () => ({} as never),
      chain: makeMockChain(),
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
    const ctx = makeCtx({ stealthOtherAta: null });
    const adapter = createProductionCloseAdapter({
      executorClient: client,
      mixerServiceFor: () => ({} as never),
      chain: makeMockChain(),
      contextResolver: async () => ctx,
    });
    const result = await adapter.submitWithdrawClose({ positionId: "pos_y" });

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
    expect(result.otherSideResidualLamports).toBe(0n);
  });

  it("submitWithdrawClose reads the stealth's other-side ATA balance after withdraw confirms (production-ix-wiring/02)", async () => {
    const { client } = makeExecutorMock();
    const ataPubkey = Keypair.generate().publicKey;
    const chain = makeMockChain({ tokenAmount: 1_230_000n });
    const ctx = makeCtx({ stealthOtherAta: ataPubkey });
    const adapter = createProductionCloseAdapter({
      executorClient: client,
      mixerServiceFor: () => ({} as never),
      chain,
      contextResolver: async () => ctx,
    });
    const result = await adapter.submitWithdrawClose({ positionId: "pos_with_other" });
    expect(result.otherSideResidualLamports).toBe(1_230_000n);
  });

  it("submitWithdrawClose surfaces 0n when the stealth ATA doesn't exist on-chain", async () => {
    const { client } = makeExecutorMock();
    const ataPubkey = Keypair.generate().publicKey;
    const chain = makeMockChain();
    const ctx = makeCtx({ stealthOtherAta: ataPubkey });
    const adapter = createProductionCloseAdapter({
      executorClient: client,
      mixerServiceFor: () => ({} as never),
      chain,
      contextResolver: async () => ctx,
    });
    const result = await adapter.submitWithdrawClose({ positionId: "pos_no_ata" });
    expect(result.otherSideResidualLamports).toBe(0n);
  });

  it("submitSwap computes min_amount_out from slippage + expectedOut and threads it to buildSwapIx", async () => {
    const { client, buildSwap } = makeExecutorMock();
    const ctx = makeCtx();
    const adapter = createProductionCloseAdapter({
      executorClient: client,
      mixerServiceFor: () => ({} as never),
      chain: makeMockChain(),
      contextResolver: async () => ctx,
    });
    await adapter.submitSwap({
      positionId: "pos_z",
      residualLamports: 1_000_000n,
      slippageBps: 50,
      expectedOutLamports: 1_000_000_000n,
    });
    const call = buildSwap.mock.calls[0][0];
    expect(call.amountIn).toBe(1_000_000n);
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
      chain: makeMockChain(),
      contextResolver: async () => ctx,
    });
    await adapter.submitSwap({
      positionId: "pos_z2",
      residualLamports: 1_000_000n,
      slippageBps: 50,
      expectedOutLamports: null,
    });
    expect(buildSwap.mock.calls[0][0].minAmountOut).toBe(1n);
  });

  it("submitMixerDeposit signs the unsigned tx with the stealth keypair and submits it via the chain (production-ix-wiring/02)", async () => {
    const { client } = makeExecutorMock();
    const ctx = makeCtx();
    const chain = makeMockChain({ sendResult: "deposit_sig_remix_abc" });
    const mockMixer = {
      buildDepositTransaction: vi
        .fn()
        .mockImplementation(async (args: { depositorPubkey: string }) => ({
          transaction: makeMockUnsignedDepositTx(new PublicKey(args.depositorPubkey)),
        })),
    };
    const adapter = createProductionCloseAdapter({
      executorClient: client,
      mixerServiceFor: () => mockMixer as never,
      chain,
      contextResolver: async () => ctx,
    });
    const result = await adapter.submitMixerDeposit({ positionId: "pos_z3" });
    expect(mockMixer.buildDepositTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        depositorPubkey: ctx.stealthKeypair.publicKey.toBase58(),
        commitment: ctx.remixCommitment,
      }),
    );
    expect(result.signature).toBe("deposit_sig_remix_abc");
    const sent = (chain as { sentTx: { raw: Uint8Array } | null }).sentTx;
    expect(sent).not.toBeNull();
    const parsed = Transaction.from(Buffer.from(sent!.raw));
    expect(parsed.signatures[0]?.publicKey.equals(ctx.stealthKeypair.publicKey)).toBe(true);
    expect(parsed.signatures[0]?.signature).not.toBeNull();
  });
});
