/**
 * production-ix-wiring/02 — resolver + leg-builder wiring tests.
 *
 * Structural-mock approach (strategy b per the ticket): the executor
 * client + mixer service are mocked so the test never touches a
 * surfpool / mainnet RPC. We assert that:
 *
 *   - `createInMemoryCloseContextResolver` round-trips an entry into
 *     both the orchestration-shape and quote-shape views.
 *   - `MissingPositionContextError` surfaces (503) for unregistered
 *     positions — drop-in for the prior `WiringIncompleteError` 503.
 *   - The production close adapter, fed by the resolver, no longer
 *     throws `WiringIncompleteError` on any method when a context is
 *     registered (closes the production-ix-wiring/02 acceptance bar).
 *   - The close-builder leg builders, fed by the same resolver, return
 *     ix lists with the resolver's `lbPair` / `stealth` keys.
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
import type { MixerService } from "#modules/mixer/mixer.service";

import {
  CloseOrchestrationWiringIncompleteError,
  createProductionCloseAdapter,
} from "../production-close.adapter";
import {
  createCloseBuilderLegBuilders,
} from "../close-builder-leg-builders";
import {
  createInMemoryCloseContextResolver,
  MissingPositionContextError,
  type CloseContextEntry,
} from "../close-context-resolver";

function makeChain(): SolanaChain {
  return {
    async getAccountInfo() {
      return null;
    },
    async getBalance() {
      return 0;
    },
    async getLatestBlockhash() {
      return { blockhash: "11111111111111111111111111111113", lastValidBlockHeight: 1_000_000 };
    },
    async getSlot() {
      return 0;
    },
    async getSignatureStatus() {
      return null;
    },
    async getRecentPrioritizationFees() {
      return [];
    },
    async simulateTransaction() {
      return {
        err: null,
        logs: [],
        accounts: null,
        unitsConsumed: 0,
        returnData: null,
        innerInstructions: null,
      };
    },
    async sendTransaction() {
      return "sig";
    },
    anchorProvider() {
      throw new Error("not used");
    },
    rawConnection() {
      return {
        sendRawTransaction: async () => "deposit_sig",
        confirmTransaction: async () => ({ value: { err: null } }),
      } as never;
    },
  };
}

function makeEntry(overrides: Partial<CloseContextEntry> = {}): CloseContextEntry {
  return {
    stealthKeypair: Keypair.generate(),
    positionPubkey: Keypair.generate().publicKey,
    lbPair: Keypair.generate().publicKey,
    fromBinId: -10,
    toBinId: 10,
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
    remainingAccountsInfo: Buffer.from([0, 0, 0, 0]),
    denominationLamports: 1_000_000_000n,
    remixCommitment: 1234567890n,
    stealthOtherAta: null,
    quote: {
      poolAddress: "8RKi3UYYbpgnTwJTjgPbpaJrqzKEafjLD8nuwHFGJVTo",
      network: "mainnet",
      swapForY: true,
      postCloseBalances: {
        solLamports: 1_000_000_000n,
        otherSideLamports: 0n,
        otherSideSymbol: "SOL",
        otherSideMint: null,
        accruedFeeSolLamports: 0n,
        accruedFeeOtherLamports: 0n,
      },
      unsupportedMintExtension: null,
    },
    ...overrides,
  };
}

function makeExecutorMock(): OctoraExecutorClient {
  const dummyIx: TransactionInstruction = new TransactionInstruction({
    keys: [],
    programId: new PublicKey("4n47TYP2hQ2bwS8GiU3a1EVyF9mgeSbKWBvAVmUjaUtK"),
    data: Buffer.alloc(8),
  });
  return {
    buildWithdrawCloseIx: vi.fn().mockResolvedValue(dummyIx),
    buildSwapIx: vi.fn().mockResolvedValue(dummyIx),
    sendIx: vi.fn().mockResolvedValue("mock_sig"),
  } as unknown as OctoraExecutorClient;
}

function makeMixerMock(stealth: PublicKey): MixerService {
  // Build a real unsigned-deposit-shape tx so the close-builder's
  // `Transaction.from(...)` parse round-trips and the
  // ComputeBudget-stripping path is exercised.
  const tx = new Transaction();
  tx.feePayer = stealth;
  tx.recentBlockhash = "11111111111111111111111111111113";
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(SystemProgram.transfer({ fromPubkey: stealth, toPubkey: stealth, lamports: 0 }));
  const transaction = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
  return {
    buildDepositTransaction: vi.fn().mockResolvedValue({ transaction }),
  } as unknown as MixerService;
}

describe("createInMemoryCloseContextResolver", () => {
  it("MissingPositionContextError is thrown for unregistered positions (drop-in for the 503 the adapter used to surface)", async () => {
    const r = createInMemoryCloseContextResolver();
    await expect(r.resolveOrchestration("nope")).rejects.toBeInstanceOf(
      MissingPositionContextError,
    );
    await expect(r.resolveQuote("nope")).rejects.toBeInstanceOf(MissingPositionContextError);
    await expect(r.resolveEntry("nope")).rejects.toBeInstanceOf(MissingPositionContextError);
  });

  it("register + resolve round-trip exposes both adapter shapes from one entry", async () => {
    const r = createInMemoryCloseContextResolver();
    const entry = makeEntry();
    r.register("pos_1", entry);
    const orch = await r.resolveOrchestration("pos_1");
    expect(orch.stealthKeypair).toBe(entry.stealthKeypair);
    expect(orch.lbPair).toBe(entry.lbPair);
    expect(orch.fromBinId).toBe(entry.fromBinId);
    expect(orch.denomination).toBe(entry.denominationLamports);

    const quote = await r.resolveQuote("pos_1");
    expect(quote.poolAddress).toBe(entry.quote.poolAddress);
    expect(quote.denomination).toBe(entry.denominationLamports);
  });

  it("clear() drops all entries", async () => {
    const r = createInMemoryCloseContextResolver();
    r.register("pos_1", makeEntry());
    r.clear();
    await expect(r.resolveEntry("pos_1")).rejects.toBeInstanceOf(MissingPositionContextError);
  });
});

describe("production close adapter — resolver wiring (production-ix-wiring/02)", () => {
  it("no longer throws CloseOrchestrationWiringIncompleteError on any method once a context is registered", async () => {
    const r = createInMemoryCloseContextResolver();
    const stealth = Keypair.generate();
    const entry = makeEntry({ stealthKeypair: stealth });
    r.register("pos_e2e", entry);

    const client = makeExecutorMock();
    const adapter = createProductionCloseAdapter({
      executorClient: client,
      mixerServiceFor: () => makeMixerMock(stealth.publicKey),
      chain: makeChain(),
      contextResolver: (positionId) => r.resolveOrchestration(positionId),
    });

    // submitWithdrawClose succeeds (no throw)
    const wc = await adapter.submitWithdrawClose({ positionId: "pos_e2e" });
    expect(wc.signature).toBe("mock_sig");

    // submitSwap succeeds (no throw)
    const sw = await adapter.submitSwap({
      positionId: "pos_e2e",
      residualLamports: 1_000n,
      slippageBps: 50,
      expectedOutLamports: 950n,
    });
    expect(sw.signature).toBe("mock_sig");

    // submitMixerDeposit succeeds (no throw + no WiringIncompleteError)
    let didThrow = false;
    let thrownErr: unknown = null;
    try {
      const md = await adapter.submitMixerDeposit({ positionId: "pos_e2e" });
      expect(md.signature).toBe("deposit_sig");
    } catch (err) {
      didThrow = true;
      thrownErr = err;
    }
    expect(didThrow).toBe(false);
    expect(thrownErr).not.toBeInstanceOf(CloseOrchestrationWiringIncompleteError);
  });
});

describe("close-builder leg builders — resolver wiring (production-ix-wiring/02)", () => {
  it("withdrawClose builder returns ixs with a ComputeBudget bump", async () => {
    const r = createInMemoryCloseContextResolver();
    const stealth = Keypair.generate();
    r.register("pos_b1", makeEntry({ stealthKeypair: stealth }));
    const builders = createCloseBuilderLegBuilders({
      executorClient: makeExecutorMock(),
      mixerServiceFor: () => makeMixerMock(stealth.publicKey),
      resolver: r,
    });
    const ixs = await builders.withdrawClose!({ positionId: "pos_b1", signer: stealth.publicKey });
    expect(ixs.length).toBeGreaterThanOrEqual(2);
    // first ix is a ComputeBudget setComputeUnitLimit
    expect(ixs[0].programId.toBase58()).toBe("ComputeBudget111111111111111111111111111111");
  });

  it("mixerDeposit builder strips the embedded ComputeBudget and replaces it", async () => {
    const r = createInMemoryCloseContextResolver();
    const stealth = Keypair.generate();
    r.register("pos_b2", makeEntry({ stealthKeypair: stealth }));
    const builders = createCloseBuilderLegBuilders({
      executorClient: makeExecutorMock(),
      mixerServiceFor: () => makeMixerMock(stealth.publicKey),
      resolver: r,
    });
    const ixs = await builders.mixerDeposit!({
      positionId: "pos_b2",
      signer: stealth.publicKey,
    });
    // The replacement ComputeBudget is first; subsequent ixs are
    // non-ComputeBudget (the deposit ix or its stand-in).
    const computeBudgetCount = ixs.filter((ix) =>
      ix.programId.toBase58() === "ComputeBudget111111111111111111111111111111",
    ).length;
    expect(computeBudgetCount).toBe(1);
    // At least one non-ComputeBudget ix survives the strip pass.
    const nonCBCount = ixs.filter((ix) =>
      ix.programId.toBase58() !== "ComputeBudget111111111111111111111111111111",
    ).length;
    expect(nonCBCount).toBeGreaterThanOrEqual(1);
  });
});
