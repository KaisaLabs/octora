/**
 * Unit tests for `OctoraExecutorClient`.
 *
 * These don't talk to a validator — they exercise the local builder
 * paths to make sure the IDL loads, PDA derivation matches the on-chain
 * constants, and each ix produces a `TransactionInstruction` with the
 * right discriminator + account count.
 */

import { describe, it, expect } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";

import {
  DLMM_EVENT_AUTHORITY,
  DLMM_PROGRAM_ID,
  OctoraExecutorClient,
  POSITION_AUTHORITY_SEED,
} from "../clients/octora-executor.client.js";

const PROGRAM_ID = new PublicKey("86zj6EvHxMywP4Bw4EyZ2VcAjLm1pfGsc6ZjsZbrWwwc");

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function makeClient(): OctoraExecutorClient {
  // No RPC traffic — the builder methods only need a Connection object
  // for the AnchorProvider constructor; they never call sendTransaction.
  const connection = new Connection("http://127.0.0.1:8899");
  return new OctoraExecutorClient({
    connection,
    relayerKeypair: Keypair.generate(),
    programId: PROGRAM_ID,
  });
}

describe("OctoraExecutorClient", () => {
  it("derives PositionAuthority PDA matching the on-chain seeds", () => {
    const client = makeClient();
    const stealth = Keypair.generate().publicKey;
    const [pda, bump] = client.derivePositionAuthority(stealth);

    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [POSITION_AUTHORITY_SEED, stealth.toBuffer()],
      PROGRAM_ID,
    );
    expect(pda.toBase58()).toBe(expected.toBase58());
    expect(bump).toBe(expectedBump);
  });

  it("buildInitPositionIx emits the correct discriminator and 8 DLMM accounts", async () => {
    const client = makeClient();
    const stealth = Keypair.generate().publicKey;
    const positionPubkey = Keypair.generate().publicKey;
    const lbPair = Keypair.generate().publicKey;
    const exitRecipient = Keypair.generate().publicKey;

    const ix = await client.buildInitPositionIx({
      stealth,
      positionPubkey,
      lbPair,
      exitRecipient,
      lowerBinId: -10,
      width: 20,
    });

    expect(ix.programId.toBase58()).toBe(PROGRAM_ID.toBase58());

    const expectedDisc = anchorDiscriminator("init_position");
    expect(ix.data.subarray(0, 8).equals(expectedDisc)).toBe(true);

    // 4 outer accounts (stealth, PA, dlmm_program, system_program) + 8 DLMM.
    expect(ix.keys.length).toBe(12);

    // Spot-check the DLMM tail: idx 6 should be the event_authority,
    // idx 7 should be the DLMM program (matches init_position.rs layout).
    expect(ix.keys[ix.keys.length - 2].pubkey.toBase58()).toBe(
      DLMM_EVENT_AUTHORITY.toBase58(),
    );
    expect(ix.keys[ix.keys.length - 1].pubkey.toBase58()).toBe(
      DLMM_PROGRAM_ID.toBase58(),
    );
  });

  it("buildClaimFeesIx forwards 14 DLMM remaining accounts and uses claim_fees discriminator", async () => {
    const client = makeClient();
    const stealth = Keypair.generate().publicKey;

    // 14 placeholder accounts — the builder doesn't validate them; the
    // on-chain program does.
    const remaining = Array.from({ length: 14 }, () => ({
      pubkey: Keypair.generate().publicKey,
      isSigner: false,
      isWritable: false,
    }));

    const ix = await client.buildClaimFeesIx({
      stealth,
      dlmmRemainingAccounts: remaining,
    });

    const expectedDisc = anchorDiscriminator("claim_fees");
    expect(ix.data.subarray(0, 8).equals(expectedDisc)).toBe(true);

    // 3 outer (stealth, PA, dlmm_program) + 14 DLMM = 17.
    expect(ix.keys.length).toBe(17);
  });

  it("buildWithdrawCloseIx serialises (i32, i32, u16) args after the discriminator", async () => {
    const client = makeClient();
    const stealth = Keypair.generate().publicKey;
    const remaining = Array.from({ length: 17 }, () => ({
      pubkey: Keypair.generate().publicKey,
      isSigner: false,
      isWritable: false,
    }));

    const ix = await client.buildWithdrawCloseIx({
      stealth,
      dlmmRemainingAccounts: remaining,
      fromBinId: -5,
      toBinId: 5,
      bpsToRemove: 10000,
    });

    expect(ix.data.length).toBe(8 + 4 + 4 + 2);
    expect(ix.data.readInt32LE(8)).toBe(-5);
    expect(ix.data.readInt32LE(12)).toBe(5);
    expect(ix.data.readUInt16LE(16)).toBe(10000);

    // 3 outer + 17 DLMM = 20.
    expect(ix.keys.length).toBe(20);
  });
});
