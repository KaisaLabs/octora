/**
 * Fail-closed regression for `compound_withdraw_add_liquidity`.
 *
 * Per ADR-0003 the on-chain handler intentionally returns
 * `ExecutorError::CompoundCpiUnsupported` without moving funds. This
 * test pins that contract so a future change that removes the
 * `err!(...)` does not silently land — any wiring of the real CPI
 * primitive must replace this test, not delete it.
 *
 * Asserts:
 *   1. Calling the ix with canonical Mixer/DLMM program IDs and a
 *      live `config` PDA fails with `CompoundCpiUnsupported`.
 *   2. The relayer signer's lamport balance is unchanged minus only
 *      the transaction fee (no compound side-effect spent SOL).
 *   3. The stealth account never materialized (would-be position
 *      owner stays a non-existent system account).
 *
 * Test plan IDs:
 *   EXEC-COMPOUND-001 returns CompoundCpiUnsupported (Anchor error name match)
 *   EXEC-COMPOUND-002 no relayer lamports moved beyond tx fee
 *   EXEC-COMPOUND-003 stealth pubkey has no on-chain account after the ix
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import { expect } from "chai";

// ─── Constants ─────────────────────────────────────────────────────────
const CONFIG_SEED = Buffer.from("config");
const MIXER_PROGRAM_ID = new PublicKey(
  "BHxT3jyWJ1mRLyMjywQoiSXBqo7YpTiGWC1oVr2Ppnzx",
);
const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);

// Mirror of `ExecutorError::CompoundCpiUnsupported` — matched by name in
// the program logs so the test stays robust against silent enum
// re-ordering. Numeric code is intentionally not hard-coded.
const EXPECTED_ERROR_NAME = "CompoundCpiUnsupported";

// ─── Helpers ───────────────────────────────────────────────────────────
async function anchorDiscriminator(name: string): Promise<Buffer> {
  const { createHash } = await import("crypto");
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

async function fundLamports(
  provider: anchor.AnchorProvider,
  to: PublicKey,
  lamports: number,
) {
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: to,
        lamports,
      }),
    ),
  );
}

function extractAnchorErrorName(err: any): string | null {
  const logs: string[] = err?.logs ?? [];
  for (const line of logs) {
    const m = line.match(/Error Code: ([A-Za-z][A-Za-z0-9]*)/);
    if (m) return m[1];
  }
  return null;
}

// ─── Test ──────────────────────────────────────────────────────────────
describe("Executor :: compound_withdraw_add_liquidity (fail-closed)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.octoraExecutor as Program;
  const programId = program.programId;

  let configPda: PublicKey;
  let relayer: Keypair;
  let stealth: Keypair;

  before(async () => {
    [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], programId);

    relayer = Keypair.generate();
    await fundLamports(provider, relayer.publicKey, 1e9);

    // Stealth is only referenced as an UncheckedAccount — it should
    // stay uninitialized through the ix (no rent paid, no data
    // written). Using a fresh Keypair gives us a non-existent pubkey
    // we can re-check post-ix.
    stealth = Keypair.generate();
  });

  it("EXEC-COMPOUND-001/002/003: rejects with CompoundCpiUnsupported and mutates no account state", async () => {
    // Build raw ix manually — Anchor's typed `.methods` would also
    // work, but this mirrors the pattern in the existing negative
    // suites and keeps the test independent of IDL drift.
    const disc = await anchorDiscriminator("compound_withdraw_add_liquidity");

    // Args: proof[256] + public_inputs[160] + Vec<u8> (4-byte LE len + bytes).
    const proof = Buffer.alloc(256); // zeros — handler ignores contents
    const publicInputs = Buffer.alloc(160);
    const liquidityParamsLen = Buffer.alloc(4); // empty vec
    const data = Buffer.concat([disc, proof, publicInputs, liquidityParamsLen]);

    const keys: AccountMeta[] = [
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: stealth.publicKey, isSigner: false, isWritable: false },
      { pubkey: MIXER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: false },
    ];

    const ix = new TransactionInstruction({ programId, keys, data });
    // Modest CU bump; the handler is tiny but keeps log space for the
    // failure path.
    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 80_000,
    });

    const relayerBalanceBefore = await provider.connection.getBalance(
      relayer.publicKey,
    );
    const stealthAcctBefore = await provider.connection.getAccountInfo(
      stealth.publicKey,
    );
    expect(stealthAcctBefore).to.equal(
      null,
      "stealth pubkey must not exist before the ix",
    );

    let errorName: string | null = null;
    try {
      await provider.sendAndConfirm(
        new Transaction().add(computeIx, ix),
        [relayer],
      );
      expect.fail("ix unexpectedly succeeded — fail-closed handler regressed");
    } catch (e) {
      errorName = extractAnchorErrorName(e);
    }

    // (1) Named error matched.
    expect(errorName).to.equal(EXPECTED_ERROR_NAME);

    // (2) No fund movement. A failed tx still burns the fee from the
    // fee-payer; assert the *only* delta is the fee (≤ 1e6 lamports
    // is generous for any sane mainnet/local-net fee schedule), and
    // that nothing else routed in.
    const relayerBalanceAfter = await provider.connection.getBalance(
      relayer.publicKey,
    );
    const delta = relayerBalanceBefore - relayerBalanceAfter;
    expect(delta).to.be.at.least(0);
    expect(delta).to.be.at.most(1_000_000);

    // (3) Stealth account still doesn't exist — handler never wrote.
    const stealthAcctAfter = await provider.connection.getAccountInfo(
      stealth.publicKey,
    );
    expect(stealthAcctAfter).to.equal(
      null,
      "stealth pubkey must remain uninitialized after fail-closed ix",
    );
  });
});
