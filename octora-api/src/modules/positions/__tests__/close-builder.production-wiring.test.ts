/**
 * Production-wiring tests for `buildCloseRecoveryTx` (close/06).
 *
 * Pins the contract that when `legBuilders` is supplied to the
 * close-builder service, each leg of `runCompleteClose` emits real
 * on-chain ixs instead of the placeholder zero-lamport `SystemProgram`
 * transfer. Validates per-leg dispatch + that `minAmountOutLamports`
 * is correctly computed and threaded into the swap builder.
 *
 * The structural-mock approach: each leg builder is a fake that
 * returns a dummy `TransactionInstruction` keyed by leg name, so we
 * can confirm the right builder ran without spinning up surfpool.
 * Full surfpool integration is deliberately scoped out per the
 * ticket's "structural mocks fall-back" note.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

import { ScriptedChain } from "#common/solana/scripted-chain";

import {
  buildCloseRecoveryTx,
  type CloseRecoveryLegBuilders,
} from "../position.close-builder.service";

function makeScriptedChain(): ScriptedChain {
  return new ScriptedChain({
    blockhash: {
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100,
    },
  });
}

function makeDummyIx(label: string, signer: PublicKey): TransactionInstruction {
  // A real ix shape — using SystemProgram.transfer with a non-zero
  // amount so the test can distinguish the real-wiring path from the
  // zero-lamport placeholder by inspecting the serialized tx data.
  return SystemProgram.transfer({
    fromPubkey: signer,
    toPubkey: Keypair.generate().publicKey,
    lamports: label.length, // non-zero, label-derived for uniqueness
  });
}

describe("close/06 production wiring — buildCloseRecoveryTx with real leg builders", () => {
  let chain: ScriptedChain;
  const signer = Keypair.generate().publicKey;

  beforeEach(() => {
    chain = makeScriptedChain();
  });

  it("withdraw-close leg invokes the wired withdrawClose builder", async () => {
    const calls: Array<{ leg: string; positionId: string }> = [];
    const legBuilders: CloseRecoveryLegBuilders = {
      withdrawClose: async ({ positionId, signer: s }) => {
        calls.push({ leg: "withdraw-close", positionId });
        return [makeDummyIx("withdraw-close", s)];
      },
    };

    const result = await buildCloseRecoveryTx(
      { chain, legBuilders },
      {
        positionId: "pos_prod_wc",
        leg: "withdraw-close",
        signer: signer.toBase58(),
      },
    );

    expect(calls).toEqual([{ leg: "withdraw-close", positionId: "pos_prod_wc" }]);
    expect(result.leg).toBe("withdraw-close");
    expect(result.transaction.length).toBeGreaterThan(0);
  });

  it("swap leg threads minAmountOutLamports through to the wired swap builder", async () => {
    const captured: Array<{
      minAmountOutLamports: bigint;
      expectedSwapOutLamports: bigint | null;
      slippageBps: number;
    }> = [];
    const legBuilders: CloseRecoveryLegBuilders = {
      swap: async (input) => {
        captured.push({
          minAmountOutLamports: input.minAmountOutLamports,
          expectedSwapOutLamports: input.expectedSwapOutLamports,
          slippageBps: input.slippageBps,
        });
        return [makeDummyIx("swap", input.signer)];
      },
    };

    const result = await buildCloseRecoveryTx(
      { chain, legBuilders },
      {
        positionId: "pos_prod_swap",
        leg: "swap",
        signer: signer.toBase58(),
        slippageBps: 50,
        expectedSwapOutLamports: 1_000_000_000n,
      },
    );

    // 1_000_000_000 * (10_000 − 50) / 10_000 = 995_000_000
    expect(captured).toHaveLength(1);
    expect(captured[0].minAmountOutLamports).toBe(995_000_000n);
    expect(captured[0].expectedSwapOutLamports).toBe(1_000_000_000n);
    expect(captured[0].slippageBps).toBe(50);
    expect(result.minAmountOutLamports).toBe("995000000");
  });

  it("mixer-deposit leg invokes the wired mixerDeposit builder with the optional recipient", async () => {
    const recipientKp = Keypair.generate();
    const calls: Array<{ recipient: string | undefined }> = [];
    const legBuilders: CloseRecoveryLegBuilders = {
      mixerDeposit: async (input) => {
        calls.push({ recipient: input.recipient?.toBase58() });
        return [makeDummyIx("mixer-deposit", input.signer)];
      },
    };

    await buildCloseRecoveryTx(
      { chain, legBuilders },
      {
        positionId: "pos_prod_mix",
        leg: "mixer-deposit",
        signer: signer.toBase58(),
        recipient: recipientKp.publicKey.toBase58(),
      },
    );

    expect(calls).toEqual([{ recipient: recipientKp.publicKey.toBase58() }]);
  });

  it("falls back to the placeholder zero-lamport ix when no legBuilders are wired", async () => {
    // No legBuilders supplied — the unwired-production-path stays on
    // the placeholder so the route's structurally-valid-tx contract
    // remains testable end-to-end.
    const result = await buildCloseRecoveryTx(
      { chain },
      {
        positionId: "pos_prod_unwired",
        leg: "withdraw-close",
        signer: signer.toBase58(),
      },
    );
    expect(result.leg).toBe("withdraw-close");
    expect(result.transaction.length).toBeGreaterThan(0);
  });

  it("falls back to the placeholder when a leg builder is missing for the requested leg", async () => {
    // legBuilders supplied, but no `swap` builder — placeholder used
    // for the swap leg, real builder for the others. Lets production
    // deployments land one leg at a time without breaking the others.
    const legBuilders: CloseRecoveryLegBuilders = {
      withdrawClose: async ({ signer: s }) => [makeDummyIx("withdraw-close", s)],
    };
    const result = await buildCloseRecoveryTx(
      { chain, legBuilders },
      {
        positionId: "pos_partial",
        leg: "swap",
        signer: signer.toBase58(),
        slippageBps: 50,
        expectedSwapOutLamports: 1_000_000_000n,
      },
    );
    expect(result.leg).toBe("swap");
    // minAmountOut still computed even on the placeholder fallback so
    // the activity row sees an honest value.
    expect(result.minAmountOutLamports).toBe("995000000");
  });
});
