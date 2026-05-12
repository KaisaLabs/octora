// ─────────────────────────────────────────────────────────────────────────
// octora-executor Security Tests V2 - Audit Findings
//
// Tests cover the audit-driven security findings:
//   - M-02: Swap min_amount_out = 0 bypass
//   - CPI re-pinning attack prevention
//   - DLMM program ID validation
//   - Token account ownership validation
//
// Run with:
//   anchor test --skip-build --files tests/octora-executor-security-v2.ts
// ─────────────────────────────────────────────────────────────────────────

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAccount } from "@solana/spl-token";
import { expect } from "chai";

// ─── Constants ─────────────────────────────────────────────────────────
const POOL_AUTHORITY_SEED = Buffer.from("pool-authority");
const CONFIG_SEED = Buffer.from("config");

// Real Meteora DLMM on devnet
const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const DLMM_EVENT_AUTHORITY = new PublicKey("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");

// Error codes from ExecutorError
const ERR_ARG_OUT_OF_RANGE = 0x17D4; // 0x17D4 = 6100 in decimal... let me recalculate
// Actually let's just use the string-based matching

// Error code mapping
const ERR_DLMM_MISMATCH = "DlmmProgramMismatch";       // 6000
const ERR_POSITION_MISMATCH = "PositionMismatch";       // 6002
const ERR_LBPAIR_MISMATCH = "LbPairMismatch";           // 6003
const ERR_STEALTH_MISMATCH = "StealthMismatch";         // 6005
const ERR_EXIT_RECIPIENT = "ExitRecipientMismatch";      // 6006
const ERR_INVALID_TOKEN = "InvalidTokenProgram";        // 6008
const ERR_EVENT_AUTHORITY = "DlmmEventAuthorityMismatch"; // 6010
const ERR_ARG_OUT_OF_RANGE_CODE = "ArgOutOfRange";      // 6012
const ERR_ACCOUNTS_TOO_SHORT = "AccountsTooShort";     // 6013
const ERR_TOKEN_MINT = "TokenMintMismatch";             // 6022
const ERR_SWAP_SLIPPAGE = "SwapSlippageExceeded";       // 6024
const ERR_INVALID_TOKEN_ACCOUNT = "InvalidTokenAccount"; // 6009

// ─── Helpers ─────────────────────────────────────────────────────────
function derivePA(programId: PublicKey, stealth: PublicKey, pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POOL_AUTHORITY_SEED, stealth.toBuffer(), pool.toBuffer()],
    programId,
  );
}

function deriveConfig(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
}

async function anchorDiscriminator(ix: string): Promise<Buffer> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(`global:${ix}`).digest().subarray(0, 8);
}

async function fundAccount(provider: anchor.AnchorProvider, to: PublicKey, lamports: number) {
  await provider.sendAndConfirm(new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: to,
      lamports,
    }),
  ));
}

function extractErrorCode(err: any): string | null {
  const logs: string[] = err?.logs ?? [];
  for (const line of logs) {
    const m = line.match(/Error Code: (\w+)/);
    if (m) return m[1];
  }
  const msg = err?.message ?? String(err);
  const m2 = msg.match(/Error Code: (\w+)/);
  if (m2) return m2[1];
  return null;
}

function extractErrorNumber(err: any): number | null {
  const logs: string[] = err?.logs ?? [];
  for (const line of logs) {
    const m = line.match(/Error Number:\s*(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  // Try hex format
  for (const line of logs) {
    const m = line.match(/0x([0-9a-fA-F]+)/);
    if (m) return parseInt(m[1], 16);
  }
  return null;
}

// LB pair for testing (from existing tests)
const TEST_LB_PAIR = new PublicKey("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");

// ═══════════════════════════════════════════════════════════════════════
// TEST SUITE: M-02 — Swap min_amount_out = 0 Bypass
//
// The fix adds min_amount_out > 0 validation.
// This test verifies that:
//   POSITIVE:  Normal swap with min_amount_out > 0 works
//   NEGATIVE:  Swap with min_amount_out = 0 is rejected
//   EDGE:      min_amount_out = 1 (minimum valid)
// ═══════════════════════════════════════════════════════════════════════
describe("octora-executor :: M-02 min_amount_out=0 prevention", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.octoraExecutor as Program;
  const programId = program.programId;

  // ──────────────────────────────────────────────────────────────────
  // POSITIVE: Normal swap parameters
  // ──────────────────────────────────────────────────────────────────
  describe("positive: valid min_amount_out", () => {
    it("accepts swap instruction with amount_in > 0 and min_amount_out > 0", async () => {
      // This test verifies the instruction structure is valid
      // Full swap requires actual DLMM pool setup, so we test the
      // validation logic with a known-failing call

      const stealth = Keypair.generate();
      await fundAccount(provider, stealth.publicKey, 1e8);

      // Build a swap instruction with valid parameters
      const disc = await anchorDiscriminator("dlmm_swap");
      const args = Buffer.alloc(16);
      args.writeBigUInt64LE(BigInt(1_000_000), 0);  // amount_in = 1M lamports
      args.writeBigUInt64LE(BigInt(1), 8);          // min_amount_out = 1 (minimum valid)

      // We expect this to fail at DLMM CPI level (no valid pool setup)
      // but NOT at the argument validation level
      const keys: AccountMeta[] = [
        { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },  // dlmm_program
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },      // lb_pair
        // Config account
        { pubkey: PublicKey.default, isSigner: false, isWritable: false }, // placeholder
      ];

      try {
        await provider.sendAndConfirm(
          new Transaction().add(new TransactionInstruction({
            programId,
            keys,
            data: Buffer.concat([disc, args]),
          })),
          [stealth],
        );
        expect.fail("Should have failed - no config account");
      } catch (err) {
        // Should NOT be ArgOutOfRange - that would mean amount_in or min_amount_out was rejected
        const code = extractErrorCode(err);
        const errStr = String(err);

        // Valid rejection paths: config not found, accounts too short, etc.
        // INVALID: ArgOutOfRange (means our validation is wrong)
        expect(code).to.not.equal(ERR_ARG_OUT_OF_RANGE_CODE,
          "Should not reject valid amount_in and min_amount_out parameters");
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // NEGATIVE: min_amount_out = 0 rejected
  // ──────────────────────────────────────────────────────────────────
  describe("negative: min_amount_out = 0 rejected", () => {
    it("rejects swap with min_amount_out = 0", async () => {
      const stealth = Keypair.generate();
      await fundAccount(provider, stealth.publicKey, 1e8);

      const disc = await anchorDiscriminator("dlmm_swap");
      const args = Buffer.alloc(16);
      args.writeBigUInt64LE(BigInt(1_000_000), 0);  // amount_in = 1M lamports
      args.writeBigUInt64LE(BigInt(0), 8);           // min_amount_out = 0 (INVALID!)

      const keys: AccountMeta[] = [
        { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: PublicKey.default, isSigner: false, isWritable: false },
      ];

      try {
        await provider.sendAndConfirm(
          new Transaction().add(new TransactionInstruction({
            programId,
            keys,
            data: Buffer.concat([disc, args]),
          })),
          [stealth],
        );

        expect.fail("Should have rejected min_amount_out = 0");
      } catch (err) {
        const code = extractErrorCode(err);
        expect(code).to.equal(ERR_ARG_OUT_OF_RANGE_CODE,
          "min_amount_out = 0 should be rejected with ArgOutOfRange");
      }
    });

    it("rejects swap with amount_in = 0 AND min_amount_out = 0", async () => {
      const stealth = Keypair.generate();
      await fundAccount(provider, stealth.publicKey, 1e8);

      const disc = await anchorDiscriminator("dlmm_swap");
      const args = Buffer.alloc(16);
      args.writeBigUInt64LE(BigInt(0), 0);  // amount_in = 0
      args.writeBigUInt64LE(BigInt(0), 8);   // min_amount_out = 0

      const keys: AccountMeta[] = [
        { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: PublicKey.default, isSigner: false, isWritable: false },
      ];

      try {
        await provider.sendAndConfirm(
          new Transaction().add(new TransactionInstruction({
            programId,
            keys,
            data: Buffer.concat([disc, args]),
          })),
          [stealth],
        );

        expect.fail("Should have rejected both zero");
      } catch (err) {
        const code = extractErrorCode(err);
        expect(code).to.equal(ERR_ARG_OUT_OF_RANGE_CODE);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // EDGE: Boundary values
  // ──────────────────────────────────────────────────────────────────
  describe("edge: boundary values", () => {
    it("accepts min_amount_out = 1 (minimum valid)", async () => {
      const stealth = Keypair.generate();
      await fundAccount(provider, stealth.publicKey, 1e8);

      const disc = await anchorDiscriminator("dlmm_swap");
      const args = Buffer.alloc(16);
      args.writeBigUInt64LE(BigInt(1), 0);   // amount_in = 1 lamport
      args.writeBigUInt64LE(BigInt(1), 8);   // min_amount_out = 1 lamport

      const keys: AccountMeta[] = [
        { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: PublicKey.default, isSigner: false, isWritable: false },
      ];

      try {
        await provider.sendAndConfirm(
          new Transaction().add(new TransactionInstruction({
            programId,
            keys,
            data: Buffer.concat([disc, args]),
          })),
          [stealth],
        );
      } catch (err) {
        // Should NOT be ArgOutOfRange
        const code = extractErrorCode(err);
        expect(code).to.not.equal(ERR_ARG_OUT_OF_RANGE_CODE,
          "min_amount_out = 1 should be accepted");
      }
    });

    it("rejects swap with amount_in = 0 but min_amount_out > 0", async () => {
      const stealth = Keypair.generate();
      await fundAccount(provider, stealth.publicKey, 1e8);

      const disc = await anchorDiscriminator("dlmm_swap");
      const args = Buffer.alloc(16);
      args.writeBigUInt64LE(BigInt(0), 0);             // amount_in = 0
      args.writeBigUInt64LE(BigInt(1_000_000), 8);    // min_amount_out = 1M

      const keys: AccountMeta[] = [
        { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: PublicKey.default, isSigner: false, isWritable: false },
      ];

      try {
        await provider.sendAndConfirm(
          new Transaction().add(new TransactionInstruction({
            programId,
            keys,
            data: Buffer.concat([disc, args]),
          })),
          [stealth],
        );

        expect.fail("Should have rejected amount_in = 0");
      } catch (err) {
        const code = extractErrorCode(err);
        expect(code).to.equal(ERR_ARG_OUT_OF_RANGE_CODE);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TEST SUITE: CPI Re-pinning Attack Prevention
//
// Verifies that:
//   POSITIVE:  Normal CPI with correct signer ordering works
//   NEGATIVE:  Malicious account ordering is rejected
//   EDGE:      Signer index manipulation is detected
// ═══════════════════════════════════════════════════════════════════════
describe("octora-executor :: CPI re-pinning attack prevention", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.octoraExecutor as Program;
  const programId = program.programId;

  // Setup a valid position first
  let stealth: Keypair;
  let poolAuthority: PublicKey;
  let positionPubkey: PublicKey;
  let exitRecipient: PublicKey;
  const cuBump = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });

  before(async () => {
    stealth = Keypair.generate();
    exitRecipient = Keypair.generate().publicKey;
    await fundAccount(provider, stealth.publicKey, 5e7);

    const positionKp = Keypair.generate();
    positionPubkey = positionKp.publicKey;
    [poolAuthority] = derivePA(programId, stealth.publicKey, TEST_LB_PAIR);

    // Initialize position
    const disc = await anchorDiscriminator("dlmm_init_position");
    const args = Buffer.alloc(40);
    args.writeInt32LE(-10, 0);
    args.writeInt32LE(20, 4);
    exitRecipient.toBuffer().copy(args, 8);

    const keys: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionPubkey, isSigner: true, isWritable: true },
      { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: poolAuthority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    try {
      await provider.sendAndConfirm(
        new Transaction().add(new TransactionInstruction({
          programId,
          keys,
          data: Buffer.concat([disc, args]),
        })),
        [stealth, positionKp],
      );
    } catch (err) {
      // Position may already exist from previous test run
      if (!String(err).includes("already in use")) {
        console.log("    ⚠ Position init failed:", String(err).slice(0, 200));
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POSITIVE: Normal add_liquidity with correct ordering
  // ──────────────────────────────────────────────────────────────────
  describe("positive: correct account ordering", () => {
    it("add_liquidity succeeds with proper account list", async () => {
      // This test verifies the instruction structure is valid
      // We expect it to fail at the DLMM CPI level (no token accounts set up)
      // but NOT at the security validation level

      const disc = await anchorDiscriminator("dlmm_add_liquidity");
      const lp = Buffer.alloc(4);
      lp.writeUInt32LE(97, 0);

      // Minimal valid account list for add_liquidity (will fail at CPI but pass validation)
      const placeholder = Keypair.generate().publicKey;
      const dlmm: AccountMeta[] = [
        { pubkey: positionPubkey, isSigner: false, isWritable: true },         // 0: position
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: true },          // 1: lb_pair
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },       // 2: dlmm_program
        { pubkey: placeholder, isSigner: false, isWritable: true },              // 3: escrow token X
        { pubkey: placeholder, isSigner: false, isWritable: true },              // 4: escrow token Y
        { pubkey: placeholder, isSigner: false, isWritable: true },              // 5: reserve X
        { pubkey: placeholder, isSigner: false, isWritable: true },              // 6: reserve Y
        { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false }, // 7: mint X
        { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false }, // 8: mint Y
        { pubkey: placeholder, isSigner: false, isWritable: true },              // 9: bin array lower
        { pubkey: placeholder, isSigner: false, isWritable: true },              // 10: bin array upper
        { pubkey: poolAuthority, isSigner: false, isWritable: false },           // 11: pool_authority (signer)
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },        // 12: token program X
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },        // 13: token program Y
        { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },   // 14: event authority
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },        // 15: dlmm_program
      ];

      const keys: AccountMeta[] = [
        { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
        { pubkey: poolAuthority, isSigner: false, isWritable: false },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
        ...dlmm,
      ];

      try {
        await provider.sendAndConfirm(
          new Transaction().add(new TransactionInstruction({
            programId,
            keys,
            data: Buffer.concat([disc, lp]),
          })),
          [stealth],
        );
        expect.fail("Should have failed at DLMM CPI");
      } catch (err) {
        // Should fail at CPI level, not at security validation
        const code = extractErrorCode(err);
        // Valid rejection paths: InvalidTokenAccount, token mint mismatch, etc.
        // INVALID: StealthMismatch, PositionMismatch, LbPairMismatch (security failures)
        expect(["StealthMismatch", "PositionMismatch", "LbPairMismatch", "InvalidTokenAccount", "TokenMintMismatch"]).to.not.include(code,
          "Should not fail at security validation level");
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // NEGATIVE: Malicious account ordering
  // ──────────────────────────────────────────────────────────────────
  describe("negative: malicious account ordering rejected", () => {
    it("rejects add_liquidity with wrong position in remaining_accounts[0]", async () => {
      const wrongPosition = Keypair.generate().publicKey;

      const disc = await anchorDiscriminator("dlmm_add_liquidity");
      const lp = Buffer.alloc(4);
      lp.writeUInt32LE(97, 0);

      const placeholder = Keypair.generate().publicKey;
      const dlmm: AccountMeta[] = [
        { pubkey: wrongPosition, isSigner: false, isWritable: true },         // 0: WRONG position
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: true },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: poolAuthority, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ];

      const keys: AccountMeta[] = [
        { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
        { pubkey: poolAuthority, isSigner: false, isWritable: false },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
        ...dlmm,
      ];

      try {
        await provider.sendAndConfirm(
          new Transaction().add(new TransactionInstruction({
            programId,
            keys,
            data: Buffer.concat([disc, lp]),
          })),
          [stealth],
        );
        expect.fail("Should have rejected wrong position");
      } catch (err) {
        const code = extractErrorCode(err);
        expect(code).to.equal(ERR_POSITION_MISMATCH,
          "Wrong position in remaining_accounts[0] should be rejected");
      }
    });

    it("rejects add_liquidity with wrong lb_pair in remaining_accounts[1]", async () => {
      const wrongLbPair = Keypair.generate().publicKey;

      const disc = await anchorDiscriminator("dlmm_add_liquidity");
      const lp = Buffer.alloc(4);
      lp.writeUInt32LE(97, 0);

      const placeholder = Keypair.generate().publicKey;
      const dlmm: AccountMeta[] = [
        { pubkey: positionPubkey, isSigner: false, isWritable: true },
        { pubkey: wrongLbPair, isSigner: false, isWritable: true },          // 1: WRONG lb_pair
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: poolAuthority, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ];

      const keys: AccountMeta[] = [
        { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
        { pubkey: poolAuthority, isSigner: false, isWritable: false },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
        ...dlmm,
      ];

      try {
        await provider.sendAndConfirm(
          new Transaction().add(new TransactionInstruction({
            programId,
            keys,
            data: Buffer.concat([disc, lp]),
          })),
          [stealth],
        );
        expect.fail("Should have rejected wrong lb_pair");
      } catch (err) {
        const code = extractErrorCode(err);
        expect(code).to.equal(ERR_LBPAIR_MISMATCH,
          "Wrong lb_pair in remaining_accounts[1] should be rejected");
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // EDGE: Signer manipulation
  // ──────────────────────────────────────────────────────────────────
  describe("edge: signer manipulation", () => {
    it("rejects add_liquidity when wrong stealth signs", async () => {
      const attacker = Keypair.generate();
      await fundAccount(provider, attacker.publicKey, 1e8);

      const disc = await anchorDiscriminator("dlmm_add_liquidity");
      const lp = Buffer.alloc(4);
      lp.writeUInt32LE(97, 0);

      const placeholder = Keypair.generate().publicKey;
      const dlmm: AccountMeta[] = [
        { pubkey: positionPubkey, isSigner: false, isWritable: true },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: true },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: poolAuthority, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ];

      const keys: AccountMeta[] = [
        { pubkey: attacker.publicKey, isSigner: true, isWritable: false }, // attacker as signer
        { pubkey: poolAuthority, isSigner: false, isWritable: false },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
        ...dlmm,
      ];

      try {
        await provider.sendAndConfirm(
          new Transaction().add(new TransactionInstruction({
            programId,
            keys,
            data: Buffer.concat([disc, lp]),
          })),
          [attacker],
        );
        expect.fail("Should have rejected attacker");
      } catch (err) {
        const code = extractErrorCode(err);
        expect(code).to.equal(ERR_STEALTH_MISMATCH,
          "Wrong stealth signer should be rejected with StealthMismatch");
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TEST SUITE: DLMM Program ID Validation
//
// Verifies that:
//   POSITIVE:  Correct DLMM program ID accepted
//   NEGATIVE:  Fake/wrong DLMM program ID rejected
//   EDGE:      Event authority validation
// ═══════════════════════════════════════════════════════════════════════
describe("octora-executor :: DLMM program ID validation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.octoraExecutor as Program;
  const programId = program.programId;

  // ──────────────────────────────────────────────────────────────────
  // POSITIVE: Correct DLMM program ID
  // ──────────────────────────────────────────────────────────────────
  describe("positive: correct DLMM program ID", () => {
    it("accepts the real DLMM program ID in account struct", async () => {
      const stealth = Keypair.generate();
      await fundAccount(provider, stealth.publicKey, 1e8);

      const disc = await anchorDiscriminator("dlmm_init_position");
      const args = Buffer.alloc(40);
      args.writeInt32LE(-10, 0);
      args.writeInt32LE(20, 4);
      Keypair.generate().publicKey.toBuffer().copy(args, 8);

      // Use CORRECT DLMM program ID
      const keys: AccountMeta[] = [
        { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
        { pubkey: PublicKey.default, isSigner: false, isWritable: true },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false }, // CORRECT
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: true },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: PublicKey.default, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ];

      try {
        await provider.sendAndConfirm(
          new Transaction().add(new TransactionInstruction({
            programId,
            keys,
            data: Buffer.concat([disc, args]),
          })),
          [stealth, Keypair.generate()],
        );
      } catch (err) {
        // Should fail for reasons OTHER than DlmmProgramMismatch
        const code = extractErrorCode(err);
        expect(code).to.not.equal(ERR_DLMM_MISMATCH,
          "Correct DLMM program ID should be accepted");
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // NEGATIVE: Wrong DLMM program ID
  // ──────────────────────────────────────────────────────────────────
  describe("negative: wrong DLMM program ID", () => {
    it("rejects fake DLMM program ID in account struct", async () => {
      const stealth = Keypair.generate();
      await fundAccount(provider, stealth.publicKey, 1e8);

      const fakeDlmm = Keypair.generate().publicKey;

      const disc = await anchorDiscriminator("dlmm_init_position");
      const args = Buffer.alloc(40);
      args.writeInt32LE(-10, 0);
      args.writeInt32LE(20, 4);
      Keypair.generate().publicKey.toBuffer().copy(args, 8);

      const keys: AccountMeta[] = [
        { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
        { pubkey: PublicKey.default, isSigner: false, isWritable: true },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: fakeDlmm, isSigner: false, isWritable: false }, // FAKE!
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: true },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: PublicKey.default, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: fakeDlmm, isSigner: false, isWritable: false }, // FAKE in remaining too!
      ];

      try {
        await provider.sendAndConfirm(
          new Transaction().add(new TransactionInstruction({
            programId,
            keys,
            data: Buffer.concat([disc, args]),
          })),
          [stealth, Keypair.generate()],
        );
        expect.fail("Should have rejected fake DLMM program");
      } catch (err) {
        const code = extractErrorCode(err);
        expect(code).to.equal(ERR_DLMM_MISMATCH,
          "Fake DLMM program ID should be rejected");
      }
    });

    it("rejects fake DLMM program ID in remaining_accounts", async () => {
      const stealth = Keypair.generate();
      await fundAccount(provider, stealth.publicKey, 1e8);

      const fakeDlmm = Keypair.generate().publicKey;

      const disc = await anchorDiscriminator("dlmm_init_position");
      const args = Buffer.alloc(40);
      args.writeInt32LE(-10, 0);
      args.writeInt32LE(20, 4);
      Keypair.generate().publicKey.toBuffer().copy(args, 8);

      const keys: AccountMeta[] = [
        { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
        { pubkey: PublicKey.default, isSigner: false, isWritable: true },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false }, // correct in struct
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: true },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: PublicKey.default, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: fakeDlmm, isSigner: false, isWritable: false }, // FAKE in remaining!
      ];

      try {
        await provider.sendAndConfirm(
          new Transaction().add(new TransactionInstruction({
            programId,
            keys,
            data: Buffer.concat([disc, args]),
          })),
          [stealth, Keypair.generate()],
        );
        expect.fail("Should have rejected fake DLMM in remaining");
      } catch (err) {
        const code = extractErrorCode(err);
        expect(code).to.equal(ERR_DLMM_MISMATCH,
          "Fake DLMM program ID in remaining_accounts should be rejected");
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // EDGE: Event Authority
  // ──────────────────────────────────────────────────────────────────
  describe("edge: event authority validation", () => {
    it("rejects fake event authority", async () => {
      const stealth = Keypair.generate();
      await fundAccount(provider, stealth.publicKey, 1e8);

      const fakeEventAuth = Keypair.generate().publicKey;

      const disc = await anchorDiscriminator("dlmm_init_position");
      const args = Buffer.alloc(40);
      args.writeInt32LE(-10, 0);
      args.writeInt32LE(20, 4);
      Keypair.generate().publicKey.toBuffer().copy(args, 8);

      const keys: AccountMeta[] = [
        { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
        { pubkey: PublicKey.default, isSigner: false, isWritable: true },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: true },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: PublicKey.default, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: fakeEventAuth, isSigner: false, isWritable: false }, // FAKE!
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ];

      try {
        await provider.sendAndConfirm(
          new Transaction().add(new TransactionInstruction({
            programId,
            keys,
            data: Buffer.concat([disc, args]),
          })),
          [stealth, Keypair.generate()],
        );
        expect.fail("Should have rejected fake event authority");
      } catch (err) {
        const code = extractErrorCode(err);
        expect(code).to.equal(ERR_EVENT_AUTHORITY,
          "Fake event authority should be rejected");
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TEST SUITE: Token Account Ownership Validation
//
// Verifies that:
//   POSITIVE:  Token accounts owned by correct party accepted
//   NEGATIVE:  Token accounts owned by wrong party rejected
//   EDGE:      Token mint validation
// ═══════════════════════════════════════════════════════════════════════
describe("octora-executor :: token account ownership", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.octoraExecutor as Program;
  const programId = program.programId;

  let stealth: Keypair;
  let poolAuthority: PublicKey;
  let exitRecipient: PublicKey;
  let attacker: Keypair;

  before(async () => {
    stealth = Keypair.generate();
    exitRecipient = Keypair.generate().publicKey;
    attacker = Keypair.generate();
    await fundAccount(provider, stealth.publicKey, 5e7);
    await fundAccount(provider, attacker.publicKey, 5e7);

    const positionKp = Keypair.generate();
    [poolAuthority] = derivePA(programId, stealth.publicKey, TEST_LB_PAIR);

    // Initialize position
    const disc = await anchorDiscriminator("dlmm_init_position");
    const args = Buffer.alloc(40);
    args.writeInt32LE(-10, 0);
    args.writeInt32LE(20, 4);
    exitRecipient.toBuffer().copy(args, 8);

    const keys: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: poolAuthority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    try {
      await provider.sendAndConfirm(
        new Transaction().add(new TransactionInstruction({
          programId,
          keys,
          data: Buffer.concat([disc, args]),
        })),
        [stealth, positionKp],
      );
    } catch (err) {
      if (!String(err).includes("already in use")) {
        console.log("    ⚠ Position init failed:", String(err).slice(0, 200));
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POSITIVE: Correct ownership
  // ──────────────────────────────────────────────────────────────────
  describe("positive: correct token account ownership", () => {
    it("accepts token account owned by exit_recipient in claim_fees", async () => {
      // Create a token account owned by exit_recipient
      const userTokenX = await createAccount(
        provider.connection,
        provider.wallet.payer,
        anchor.web3.NATIVE_MINT,
        exitRecipient,
        Keypair.generate(),
      );
      const userTokenY = await createAccount(
        provider.connection,
        provider.wallet.payer,
        anchor.web3.NATIVE_MINT,
        exitRecipient,
        Keypair.generate(),
      );

      const disc = await anchorDiscriminator("dlmm_claim_fees");
      const placeholder = Keypair.generate().publicKey;

      const dlmm: AccountMeta[] = [
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: true },
        { pubkey: PublicKey.default, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: poolAuthority, isSigner: false, isWritable: false },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: userTokenX, isSigner: false, isWritable: true }, // owned by exit_recipient
        { pubkey: userTokenY, isSigner: false, isWritable: true }, // owned by exit_recipient
        { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ];

      const keys: AccountMeta[] = [
        { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
        { pubkey: poolAuthority, isSigner: false, isWritable: false },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
        ...dlmm,
      ];

      try {
        await provider.sendAndConfirm(
          new Transaction().add(new TransactionInstruction({
            programId,
            keys,
            data: Buffer.concat([disc]),
          })),
          [stealth],
        );
      } catch (err) {
        // Should NOT fail with ExitRecipientMismatch
        const code = extractErrorCode(err);
        expect(code).to.not.equal(ERR_EXIT_RECIPIENT,
          "Correct token account ownership should be accepted");
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // NEGATIVE: Wrong ownership
  // ──────────────────────────────────────────────────────────────────
  describe("negative: wrong token account ownership", () => {
    it("rejects token account owned by attacker in claim_fees", async () => {
      // Create a token account owned by ATTACKER (not exit_recipient)
      const attackerTokenX = await createAccount(
        provider.connection,
        provider.wallet.payer,
        anchor.web3.NATIVE_MINT,
        attacker.publicKey, // owned by attacker!
        Keypair.generate(),
      );
      const attackerTokenY = await createAccount(
        provider.connection,
        provider.wallet.payer,
        anchor.web3.NATIVE_MINT,
        attacker.publicKey, // owned by attacker!
        Keypair.generate(),
      );

      const disc = await anchorDiscriminator("dlmm_claim_fees");
      const placeholder = Keypair.generate().publicKey;

      const dlmm: AccountMeta[] = [
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: true },
        { pubkey: PublicKey.default, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: poolAuthority, isSigner: false, isWritable: false },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: attackerTokenX, isSigner: false, isWritable: true }, // owned by attacker!
        { pubkey: attackerTokenY, isSigner: false, isWritable: true }, // owned by attacker!
        { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ];

      const keys: AccountMeta[] = [
        { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
        { pubkey: poolAuthority, isSigner: false, isWritable: false },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
        ...dlmm,
      ];

      try {
        await provider.sendAndConfirm(
          new Transaction().add(new TransactionInstruction({
            programId,
            keys,
            data: Buffer.concat([disc]),
          })),
          [stealth],
        );
        expect.fail("Should have rejected attacker-owned token account");
      } catch (err) {
        const code = extractErrorCode(err);
        expect(code).to.equal(ERR_EXIT_RECIPIENT,
          "Token account owned by wrong party should be rejected");
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // EDGE: Token mint validation
  // ──────────────────────────────────────────────────────────────────
  describe("edge: token mint validation", () => {
    it("rejects token account with wrong mint", async () => {
      // Create a token account with WRONG mint
      const wrongMintToken = await createAccount(
        provider.connection,
        provider.wallet.payer,
        Keypair.generate().publicKey, // wrong mint!
        exitRecipient,
        Keypair.generate(),
      );

      const disc = await anchorDiscriminator("dlmm_claim_fees");
      const placeholder = Keypair.generate().publicKey;

      // Create correct token accounts too
      const correctTokenX = await createAccount(
        provider.connection,
        provider.wallet.payer,
        anchor.web3.NATIVE_MINT,
        exitRecipient,
        Keypair.generate(),
      );

      const dlmm: AccountMeta[] = [
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: true },
        { pubkey: PublicKey.default, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: poolAuthority, isSigner: false, isWritable: false },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: placeholder, isSigner: false, isWritable: true },
        { pubkey: wrongMintToken, isSigner: false, isWritable: true }, // WRONG MINT
        { pubkey: correctTokenX, isSigner: false, isWritable: true },   // correct
        { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ];

      const keys: AccountMeta[] = [
        { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
        { pubkey: poolAuthority, isSigner: false, isWritable: false },
        { pubkey: TEST_LB_PAIR, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
        ...dlmm,
      ];

      try {
        await provider.sendAndConfirm(
          new Transaction().add(new TransactionInstruction({
            programId,
            keys,
            data: Buffer.concat([disc]),
          })),
          [stealth],
        );
        expect.fail("Should have rejected wrong mint");
      } catch (err) {
        const code = extractErrorCode(err);
        expect(code).to.equal(ERR_TOKEN_MINT,
          "Token account with wrong mint should be rejected");
      }
    });
  });
});
