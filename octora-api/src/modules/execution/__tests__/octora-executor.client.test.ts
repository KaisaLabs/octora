/**
 * Unit tests for `OctoraExecutorClient`.
 *
 * These don't talk to a validator — they exercise the local builder
 * paths to make sure the IDL loads, PDA derivation matches the on-chain
 * constants, and each ix produces a `TransactionInstruction` with the
 * right discriminator + account count.
 *
 * Test plan IDs: API-EXE-001/002/003/004/005.
 *
 * Source of truth: `programs/octora-executor/src/instructions/dlmm/*.rs`
 * (e.g. init_position.rs:19 `seeds = [POOL_AUTHORITY_SEED, stealth, lb_pair]`)
 * and `octora_executor.json` IDL — both anchored to the on-chain program.
 */

import { describe, it, expect } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";

import {
  DLMM_EVENT_AUTHORITY,
  DLMM_PROGRAM_ID,
  OctoraExecutorClient,
  POOL_AUTHORITY_SEED,
} from "../clients/octora-executor.client.js";

const PROGRAM_ID = new PublicKey("4n47TYP2hQ2bwS8GiU3a1EVyF9mgeSbKWBvAVmUjaUtK");

function anchorDiscriminator(snakeName: string): Buffer {
  return createHash("sha256").update(`global:${snakeName}`).digest().subarray(0, 8);
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
  it("derivePoolAuthority matches the on-chain seeds [pool-authority, stealth, lb_pair]", () => {
    const client = makeClient();
    const stealth = Keypair.generate().publicKey;
    const lbPair = Keypair.generate().publicKey;
    const [pda, bump] = client.derivePoolAuthority(stealth, lbPair);

    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [POOL_AUTHORITY_SEED, stealth.toBuffer(), lbPair.toBuffer()],
      PROGRAM_ID,
    );
    expect(pda.toBase58()).toBe(expected.toBase58());
    expect(bump).toBe(expectedBump);
  });

  it("buildInitPositionIx emits the dlmm_init_position discriminator and 5 outer + 8 remaining accounts", async () => {
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

    const expectedDisc = anchorDiscriminator("dlmm_init_position");
    expect(ix.data.subarray(0, 8).equals(expectedDisc)).toBe(true);

    // 6 outer (stealth, poolAuthority, lbPair, dlmmProgram, config, systemProgram)
    // + 8 DLMM remaining accounts (relayer, position, lbPair, PA, sysProgram,
    // rent, event_authority, dlmm_program).
    expect(ix.keys.length).toBe(14);

    // Spot-check the DLMM tail: idx -2 should be the event_authority,
    // idx -1 should be the DLMM program (matches init_position.rs layout).
    expect(ix.keys[ix.keys.length - 2].pubkey.toBase58()).toBe(
      DLMM_EVENT_AUTHORITY.toBase58(),
    );
    expect(ix.keys[ix.keys.length - 1].pubkey.toBase58()).toBe(
      DLMM_PROGRAM_ID.toBase58(),
    );
  });

  it("buildClaimFeesIx forwards 14 remaining accounts and uses dlmm_claim_fees discriminator", async () => {
    const client = makeClient();
    const stealth = Keypair.generate().publicKey;
    const lbPair = Keypair.generate().publicKey;

    // 14 placeholder accounts — the builder doesn't validate them; the
    // on-chain program does.
    const remaining = Array.from({ length: 14 }, () => ({
      pubkey: Keypair.generate().publicKey,
      isSigner: false,
      isWritable: false,
    }));

    const ix = await client.buildClaimFeesIx({
      stealth,
      lbPair,
      dlmmRemainingAccounts: remaining,
      minBinId: -10,
      maxBinId: 10,
      remainingAccountsInfo: Buffer.from([0, 0, 0, 0]),
    });

    const expectedDisc = anchorDiscriminator("dlmm_claim_fees");
    expect(ix.data.subarray(0, 8).equals(expectedDisc)).toBe(true);

    // 5 outer (stealth, poolAuthority, lbPair, dlmmProgram, config) + 14 remaining = 19.
    expect(ix.keys.length).toBe(19);
  });

  it("buildWithdrawCloseIx serialises (i32, i32, u16, Vec<u8>) args after the dlmm_withdraw_close discriminator", async () => {
    const client = makeClient();
    const stealth = Keypair.generate().publicKey;
    const lbPair = Keypair.generate().publicKey;
    const remaining = Array.from({ length: 17 }, () => ({
      pubkey: Keypair.generate().publicKey,
      isSigner: false,
      isWritable: false,
    }));

    const remainingAccountsInfo = Buffer.from([0, 0, 0, 0]);
    const ix = await client.buildWithdrawCloseIx({
      stealth,
      lbPair,
      dlmmRemainingAccounts: remaining,
      fromBinId: -5,
      toBinId: 5,
      bpsToRemove: 10000,
      remainingAccountsInfo,
    });

    const expectedDisc = anchorDiscriminator("dlmm_withdraw_close");
    expect(ix.data.subarray(0, 8).equals(expectedDisc)).toBe(true);

    // 8 disc + 4 (i32 fromBinId) + 4 (i32 toBinId) + 2 (u16 bps)
    // + 4 (Borsh u32 length prefix for Vec<u8>) + remainingAccountsInfo.length.
    expect(ix.data.length).toBe(8 + 4 + 4 + 2 + 4 + remainingAccountsInfo.length);
    expect(ix.data.readInt32LE(8)).toBe(-5);
    expect(ix.data.readInt32LE(12)).toBe(5);
    expect(ix.data.readUInt16LE(16)).toBe(10000);

    // 5 outer (stealth, poolAuthority, lbPair, dlmmProgram, config) + 17 remaining = 22.
    expect(ix.keys.length).toBe(22);
  });
});
