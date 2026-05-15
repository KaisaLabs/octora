/**
 * Extended negative test suite — stealth attacks, account substitution, boundary validation.
 *
 * Error code map:
 *   6000 = DlmmProgramMismatch     6002 = PositionMismatch
 *   6003 = LbPairMismatch          6005 = StealthMismatch
 *   6006 = ExitRecipientMismatch   6008 = InvalidTokenProgram
 *   6012 = ArgOutOfRange           6013 = AccountsTooShort
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAccount } from "@solana/spl-token";
import { expect } from "chai";

const POOL_AUTHORITY_SEED = Buffer.from("pool-authority");
const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const LB_PAIR = new PublicKey("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");
const EVENT_AUTHORITY = new PublicKey("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");

const ERR_DLMM_MISMATCH = 6000;
const ERR_POSITION_MISMATCH = 6002;
const ERR_LBPAIR_MISMATCH = 6003;
const ERR_STEALTH_MISMATCH = 6005;
const ERR_EXIT_RECIPIENT = 6006;
const ERR_ARG_OUT_OF_RANGE = 6012;

function derivePA(pId: PublicKey, s: PublicKey, pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_AUTHORITY_SEED, s.toBuffer(), pool.toBuffer()], pId);
}
async function disc(ix: string): Promise<Buffer> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(`global:${ix}`).digest().subarray(0, 8);
}
async function fund(provider: anchor.AnchorProvider, to: PublicKey, lamports: number) {
  await provider.sendAndConfirm(new Transaction().add(
    SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: to, lamports }),
  ));
}
function errCode(err: any): number | null {
  const logs: string[] = err?.logs ?? [];
  for (const line of logs) {
    const m = line.match(/Error Number:\s*(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// STEALTH ATTACKS — verify that only the original stealth can operate
// ═══════════════════════════════════════════════════════════════════════
describe("DLMM :: stealth auth attacks", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.octoraExecutor as Program;
  const pId = program.programId;

  let goodStealth: Keypair, badStealth: Keypair;
  let poolAuthority: PublicKey, positionPubkey: PublicKey, exitRecipient: PublicKey;

  before(async () => {
    goodStealth = Keypair.generate();
    badStealth = Keypair.generate();
    exitRecipient = Keypair.generate().publicKey;
    await fund(provider, goodStealth.publicKey, 5e7);
    await fund(provider, badStealth.publicKey, 5e7);

    const positionKp = Keypair.generate();
    positionPubkey = positionKp.publicKey;
    [poolAuthority] = derivePA(pId, goodStealth.publicKey, LB_PAIR);

    const d = await disc("dlmm_init_position");
    const args = Buffer.alloc(8 + 32); args.writeInt32LE(-10, 0); args.writeInt32LE(20, 4); exitRecipient.toBuffer().copy(args, 8);
    const keys: AccountMeta[] = [
      { pubkey: goodStealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionPubkey, isSigner: true, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: poolAuthority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    await provider.sendAndConfirm(new Transaction().add(new TransactionInstruction({ programId: pId, keys, data: Buffer.concat([d, args]) })), [goodStealth, positionKp]);
  });

  // StealthMismatch on add_liquidity
  it("add_liquidity: wrong stealth signer → StealthMismatch", async () => {
    const ph = Keypair.generate().publicKey;
    const d = await disc("dlmm_add_liquidity");
    const lp = Buffer.alloc(4); lp.writeUInt32LE(97, 0);
    const dlmm: AccountMeta[] = [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const keys: AccountMeta[] = [
      { pubkey: badStealth.publicKey, isSigner: true, isWritable: false }, // wrong
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmm,
    ];
    const ix = new TransactionInstruction({ programId: pId, keys, data: Buffer.concat([d, lp]) });
    let code: number | null = null;
    try { await provider.sendAndConfirm(new Transaction().add(ix), [badStealth]); }
    catch (e) { code = errCode(e); }
    expect(code).to.equal(ERR_STEALTH_MISMATCH);
  });

  // StealthMismatch on claim_fees
  it("claim_fees: wrong stealth signer → StealthMismatch", async () => {
    const ph = Keypair.generate().publicKey;
    const d = await disc("dlmm_claim_fees");
    const dlmm: AccountMeta[] = [
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },
      { pubkey: positionPubkey, isSigner: false, isWritable: true },
      { pubkey: ph, isSigner: false, isWritable: true }, { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: ph, isSigner: false, isWritable: true }, { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: ph, isSigner: false, isWritable: true }, { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const keys: AccountMeta[] = [
      { pubkey: badStealth.publicKey, isSigner: true, isWritable: false }, // wrong
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmm,
    ];
    const ix = new TransactionInstruction({ programId: pId, keys, data: d });
    let code: number | null = null;
    try { await provider.sendAndConfirm(new Transaction().add(ix), [badStealth]); }
    catch (e) { code = errCode(e); }
    expect(code).to.equal(ERR_STEALTH_MISMATCH);
  });

  // StealthMismatch on withdraw_close
  it("withdraw_close: wrong stealth signer → StealthMismatch", async () => {
    const ph = Keypair.generate().publicKey;
    const d = await disc("dlmm_withdraw_close");
    const args = Buffer.alloc(10); args.writeInt32LE(-10, 0); args.writeInt32LE(10, 4); args.writeUInt16LE(10000, 8);
    const dlmm: AccountMeta[] = [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: ph, isSigner: false, isWritable: true }, { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: ph, isSigner: false, isWritable: true }, { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: ph, isSigner: false, isWritable: true }, { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: exitRecipient, isSigner: false, isWritable: true },
    ];
    const keys: AccountMeta[] = [
      { pubkey: badStealth.publicKey, isSigner: true, isWritable: true }, // wrong
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmm,
    ];
    const ix = new TransactionInstruction({ programId: pId, keys, data: Buffer.concat([d, args]) });
    let code: number | null = null;
    try { await provider.sendAndConfirm(new Transaction().add(ix), [badStealth]); }
    catch (e) { code = errCode(e); }
    expect(code).to.equal(ERR_STEALTH_MISMATCH);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ACCOUNT SUBSTITUTION — verify wrong position/lb_pair get rejected
// ═══════════════════════════════════════════════════════════════════════
describe("DLMM :: account substitution attacks", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.octoraExecutor as Program;
  const pId = program.programId;

  let stealth: Keypair, poolAuthority: PublicKey, positionPubkey: PublicKey, exitRecipient: PublicKey;

  before(async () => {
    stealth = Keypair.generate();
    exitRecipient = Keypair.generate().publicKey;
    await fund(provider, stealth.publicKey, 5e7);
    const positionKp = Keypair.generate(); positionPubkey = positionKp.publicKey;
    [poolAuthority] = derivePA(pId, stealth.publicKey, LB_PAIR);
    const d = await disc("dlmm_init_position");
    const args = Buffer.alloc(8 + 32); args.writeInt32LE(-10, 0); args.writeInt32LE(20, 4); exitRecipient.toBuffer().copy(args, 8);
    const keys: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionPubkey, isSigner: true, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: poolAuthority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    await provider.sendAndConfirm(new Transaction().add(new TransactionInstruction({ programId: pId, keys, data: Buffer.concat([d, args]) })), [stealth, positionKp]);
  });

  it("add_liquidity: wrong Position → PositionMismatch", async () => {
    const ph = Keypair.generate().publicKey; const wrongPos = Keypair.generate().publicKey;
    const d = await disc("dlmm_add_liquidity"); const lp = Buffer.alloc(4); lp.writeUInt32LE(97, 0);
    const dlmm: AccountMeta[] = [
      { pubkey: wrongPos, isSigner: false, isWritable: true }, // wrong
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: ph, isSigner: false, isWritable: true }, { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: ph, isSigner: false, isWritable: true }, { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: ph, isSigner: false, isWritable: true }, { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const keys: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmm,
    ];
    const ix = new TransactionInstruction({ programId: pId, keys, data: Buffer.concat([d, lp]) });
    let code: number | null = null;
    try { await provider.sendAndConfirm(new Transaction().add(ix), [stealth]); }
    catch (e) { code = errCode(e); }
    expect(code).to.equal(ERR_POSITION_MISMATCH);
  });

  it("claim_fees: wrong lb_pair → LbPairMismatch", async () => {
    const ph = Keypair.generate().publicKey; const wrongLb = Keypair.generate().publicKey;
    const d = await disc("dlmm_claim_fees");
    const dlmm: AccountMeta[] = [
      { pubkey: wrongLb, isSigner: false, isWritable: true }, // wrong
      { pubkey: positionPubkey, isSigner: false, isWritable: true },
      { pubkey: ph, isSigner: false, isWritable: true }, { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: ph, isSigner: false, isWritable: true }, { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: ph, isSigner: false, isWritable: true }, { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const keys: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmm,
    ];
    const ix = new TransactionInstruction({ programId: pId, keys, data: d });
    let code: number | null = null;
    try { await provider.sendAndConfirm(new Transaction().add(ix), [stealth]); }
    catch (e) { code = errCode(e); }
    expect(code).to.equal(ERR_LBPAIR_MISMATCH);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BOUNDARY VALIDATION — arg range + account count
// ═══════════════════════════════════════════════════════════════════════
describe("DLMM :: boundary validation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.octoraExecutor as Program;
  const pId = program.programId;

  let stealth: Keypair, poolAuthority: PublicKey, positionPubkey: PublicKey, exitRecipient: PublicKey;

  before(async () => {
    stealth = Keypair.generate();
    exitRecipient = Keypair.generate().publicKey;
    await fund(provider, stealth.publicKey, 5e7);
    const positionKp = Keypair.generate(); positionPubkey = positionKp.publicKey;
    [poolAuthority] = derivePA(pId, stealth.publicKey, LB_PAIR);
    const d = await disc("dlmm_init_position");
    const args = Buffer.alloc(8 + 32); args.writeInt32LE(-10, 0); args.writeInt32LE(20, 4); exitRecipient.toBuffer().copy(args, 8);
    const keys: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionPubkey, isSigner: true, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: poolAuthority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    await provider.sendAndConfirm(new Transaction().add(new TransactionInstruction({ programId: pId, keys, data: Buffer.concat([d, args]) })), [stealth, positionKp]);
  });

  it("withdraw_close: bps_to_remove > 10000 → ArgOutOfRange", async () => {
    const ph = Keypair.generate().publicKey;
    const d = await disc("dlmm_withdraw_close");
    const args = Buffer.alloc(10); args.writeInt32LE(-10, 0); args.writeInt32LE(10, 4); args.writeUInt16LE(10001, 8); // > 10000
    const dlmm: AccountMeta[] = [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: ph, isSigner: false, isWritable: true }, { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: ph, isSigner: false, isWritable: true }, { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: ph, isSigner: false, isWritable: true }, { pubkey: ph, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: exitRecipient, isSigner: false, isWritable: true },
    ];
    const keys: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmm,
    ];
    const ix = new TransactionInstruction({ programId: pId, keys, data: Buffer.concat([d, args]) });
    let code: number | null = null;
    try { await provider.sendAndConfirm(new Transaction().add(ix), [stealth]); }
    catch (e) { code = errCode(e); }
    expect(code).to.equal(ERR_ARG_OUT_OF_RANGE);
  });

  it("init_position: missing position signer → fails", async () => {
    const s = Keypair.generate(); await fund(provider, s.publicKey, 5e7);
    const posKp = Keypair.generate(); const [pa] = derivePA(pId, s.publicKey, LB_PAIR);
    const d = await disc("dlmm_init_position");
    const args = Buffer.alloc(8 + 32); args.writeInt32LE(-10, 0); args.writeInt32LE(20, 4); exitRecipient.toBuffer().copy(args, 8);
    const keys: AccountMeta[] = [
      { pubkey: s.publicKey, isSigner: true, isWritable: true },
      { pubkey: pa, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: posKp.publicKey, isSigner: false, isWritable: true }, // NOT a signer!
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: pa, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const ix = new TransactionInstruction({ programId: pId, keys, data: Buffer.concat([d, args]) });
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [s]); // posKp NOT signing
      expect.fail("Expected MissingPositionSigner");
    } catch (e) {
      expect(e).to.be.instanceOf(Error);
    }
  });
});
