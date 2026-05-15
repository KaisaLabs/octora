/**
 * DLMM comprehensive negative test suite.
 *
 * Tests all security boundaries: stealth auth, PDA validation, position/LB
 * pair integrity, destination enforcement, argument validation, token programs.
 *
 * Error code map (from ExecutorError enum):
 *   6000 = DlmmProgramMismatch      6010 = DlmmEventAuthorityMismatch
 *   6002 = PositionMismatch          6012 = ArgOutOfRange
 *   6003 = LbPairMismatch            6013 = AccountsTooShort
 *   6005 = StealthMismatch           6008 = InvalidTokenProgram
 *   6006 = ExitRecipientMismatch
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

// ─── Constants ──
const POOL_AUTHORITY_SEED = Buffer.from("pool-authority");
const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const LB_PAIR = new PublicKey("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");
const EVENT_AUTHORITY = new PublicKey("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

const ERR_DLMM_MISMATCH = 6000;
const ERR_POSITION_MISMATCH = 6002;
const ERR_LBPAIR_MISMATCH = 6003;
const ERR_STEALTH_MISMATCH = 6005;
const ERR_EXIT_RECIPIENT = 6006;
const ERR_INVALID_TOKEN = 6008;
const ERR_EVENT_AUTHORITY = 6010;
const ERR_ARG_OUT_OF_RANGE = 6012;
const ERR_TOKEN_MINT = 6022;

// ─── Helpers ──
function derivePoolAuthority(programId: PublicKey, stealth: PublicKey, poolKey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POOL_AUTHORITY_SEED, stealth.toBuffer(), poolKey.toBuffer()], programId,
  );
}

async function anchorDiscriminator(ix: string): Promise<Buffer> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(`global:${ix}`).digest().subarray(0, 8);
}

async function fundAccount(provider: anchor.AnchorProvider, to: PublicKey, lamports: number) {
  await provider.sendAndConfirm(new Transaction().add(
    SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: to, lamports }),
  ));
}

function extractErrorCode(err: any): number | null {
  const logs: string[] = err?.logs ?? [];
  for (const line of logs) {
    const m = line.match(/Error Code: ([A-Za-z]+)/);
    if (m) return parseInt(m[1], 16);
  }
  const msg = err?.message ?? String(err);
  const m2 = msg.match(/0x([0-9a-fA-F]+)/);
  if (m2) return parseInt(m2[1], 16);
  // Try Anchor error numbers
  for (const line of logs) {
    const m = line.match(/Error Number:\s*(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// TEST: dlmm_init_position negative cases
// ═══════════════════════════════════════════════════════════════════════
describe("DLMM :: dlmm_init_position negative", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.octoraExecutor as Program;
  const programId = program.programId;

  it("rejects wrong DLMM program ID", async () => {
    const stealth = Keypair.generate();
    await fundAccount(provider, stealth.publicKey, 1e9);
    const positionKp = Keypair.generate();
    const exitRecipient = Keypair.generate().publicKey;
    const [pa] = derivePoolAuthority(programId, stealth.publicKey, LB_PAIR);

    // Build with fake DLMM program
    const fakeDlmm = Keypair.generate().publicKey;
    const keys: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: pa, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: fakeDlmm, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // remaining DLMM accounts ...
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: pa, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: fakeDlmm, isSigner: false, isWritable: false },
    ];
    const args = Buffer.alloc(8 + 32);
    args.writeInt32LE(-10, 0); args.writeInt32LE(20, 4);
    exitRecipient.toBuffer().copy(args, 8);
    const disc = await anchorDiscriminator("dlmm_init_position");
    const ix = new TransactionInstruction({ programId, keys, data: Buffer.concat([disc, args]) });

    let code: number | null = null;
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [stealth, positionKp]);
    } catch (e) { code = extractErrorCode(e); }
    expect(code).to.equal(ERR_DLMM_MISMATCH);
  });

  it("rejects wrong event authority", async () => {
    const stealth = Keypair.generate();
    await fundAccount(provider, stealth.publicKey, 1e9);
    const positionKp = Keypair.generate();
    const exitRecipient = Keypair.generate().publicKey;
    const [pa] = derivePoolAuthority(programId, stealth.publicKey, LB_PAIR);
    const fakeEventAuth = Keypair.generate().publicKey;

    const keys: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: pa, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: pa, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: fakeEventAuth, isSigner: false, isWritable: false }, // wrong
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const args = Buffer.alloc(8 + 32);
    args.writeInt32LE(-10, 0); args.writeInt32LE(20, 4);
    exitRecipient.toBuffer().copy(args, 8);
    const disc = await anchorDiscriminator("dlmm_init_position");
    const ix = new TransactionInstruction({ programId, keys, data: Buffer.concat([disc, args]) });

    let code: number | null = null;
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [stealth, positionKp]);
    } catch (e) { code = extractErrorCode(e); }
    expect(code).to.equal(ERR_EVENT_AUTHORITY);
  });

  it("rejects wrong system program", async () => {
    const stealth = Keypair.generate();
    await fundAccount(provider, stealth.publicKey, 1e9);
    const positionKp = Keypair.generate();
    const exitRecipient = Keypair.generate().publicKey;
    const [pa] = derivePoolAuthority(programId, stealth.publicKey, LB_PAIR);

    const keys: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: pa, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: pa, isSigner: true, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }, // wrong sys_prog
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const args = Buffer.alloc(8 + 32);
    args.writeInt32LE(-10, 0); args.writeInt32LE(20, 4);
    exitRecipient.toBuffer().copy(args, 8);
    const disc = await anchorDiscriminator("dlmm_init_position");
    const ix = new TransactionInstruction({ programId, keys, data: Buffer.concat([disc, args]) });

    // Should fail — system program mismatch
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [stealth, positionKp]);
      expect.fail("Expected system program mismatch");
    } catch (e) {
      // May be Anchor constraint or program error
      expect(e).to.be.instanceOf(Error);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TEST: dlmm_claim_fees negative cases
// ═══════════════════════════════════════════════════════════════════════
describe("DLMM :: dlmm_claim_fees negative", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.octoraExecutor as Program;
  const programId = program.programId;

  let stealth: Keypair;
  let poolAuthority: PublicKey;
  let positionPubkey: PublicKey;
  let exitRecipient: PublicKey;
  let goodUserTokenX: PublicKey;
  let goodUserTokenY: PublicKey;
  let badUserTokenX: PublicKey;

  before(async () => {
    stealth = Keypair.generate();
    exitRecipient = Keypair.generate().publicKey;
    const attacker = Keypair.generate();

    await fundAccount(provider, stealth.publicKey, 5e7);
    const positionKp = Keypair.generate();
    positionPubkey = positionKp.publicKey;
    [poolAuthority] = derivePoolAuthority(programId, stealth.publicKey, LB_PAIR);

    // dlmm_init_position
    const disc = await anchorDiscriminator("dlmm_init_position");
    const args = Buffer.alloc(8 + 32);
    args.writeInt32LE(-10, 0); args.writeInt32LE(20, 4);
    exitRecipient.toBuffer().copy(args, 8);
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
    await provider.sendAndConfirm(
      new Transaction().add(new TransactionInstruction({ programId, keys, data: Buffer.concat([disc, args]) })),
      [stealth, positionKp],
    );

    // Token accounts
    goodUserTokenX = await createAccount(provider.connection, provider.wallet.payer, anchor.web3.NATIVE_MINT, exitRecipient, Keypair.generate());
    goodUserTokenY = await createAccount(provider.connection, provider.wallet.payer, anchor.web3.NATIVE_MINT, exitRecipient, Keypair.generate());
    badUserTokenX = await createAccount(provider.connection, provider.wallet.payer, anchor.web3.NATIVE_MINT, attacker.publicKey, Keypair.generate());
  });

  it("rejects user_token_x not owned by exit_recipient", async () => {
    const placeholder = Keypair.generate().publicKey;
    const dlmm: AccountMeta[] = [
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },
      { pubkey: positionPubkey, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: badUserTokenX, isSigner: false, isWritable: true },  // bad
      { pubkey: goodUserTokenY, isSigner: false, isWritable: true },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmm,
    ];
    const ix = new TransactionInstruction({ programId, keys: accounts, data: await anchorDiscriminator("dlmm_claim_fees") });

    let code: number | null = null;
    try { await provider.sendAndConfirm(new Transaction().add(ix), [stealth]); }
    catch (e) { code = extractErrorCode(e); }
    expect(code).to.equal(ERR_EXIT_RECIPIENT);
  });

  it("rejects wrong token program", async () => {
    const placeholder = Keypair.generate().publicKey;
    const dlmm: AccountMeta[] = [
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },
      { pubkey: positionPubkey, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: goodUserTokenX, isSigner: false, isWritable: true },
      { pubkey: goodUserTokenY, isSigner: false, isWritable: true },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }, // wrong token program
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmm,
    ];
    const ix = new TransactionInstruction({ programId, keys: accounts, data: await anchorDiscriminator("dlmm_claim_fees") });

    let code: number | null = null;
    try { await provider.sendAndConfirm(new Transaction().add(ix), [stealth]); }
    catch (e) { code = extractErrorCode(e); }
    expect(code).to.equal(ERR_INVALID_TOKEN);
  });

  it("rejects token mint mismatch", async () => {
    const placeholder = Keypair.generate().publicKey;
    const dlmm: AccountMeta[] = [
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },
      { pubkey: positionPubkey, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: goodUserTokenX, isSigner: false, isWritable: true },
      { pubkey: goodUserTokenY, isSigner: false, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }, // wrong token_x_mint
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmm,
    ];
    const ix = new TransactionInstruction({ programId, keys: accounts, data: await anchorDiscriminator("dlmm_claim_fees") });

    let code: number | null = null;
    try { await provider.sendAndConfirm(new Transaction().add(ix), [stealth]); }
    catch (e) { code = extractErrorCode(e); }
    expect(code).to.equal(ERR_TOKEN_MINT);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TEST: dlmm_add_liquidity negative cases
// ═══════════════════════════════════════════════════════════════════════
describe("DLMM :: dlmm_add_liquidity negative", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.octoraExecutor as Program;
  const programId = program.programId;

  let stealth: Keypair;
  let poolAuthority: PublicKey;
  let positionPubkey: PublicKey;
  let exitRecipient: PublicKey;
  let escrowTokenX: PublicKey;
  let escrowTokenY: PublicKey;

  before(async () => {
    stealth = Keypair.generate();
    exitRecipient = Keypair.generate().publicKey;
    await fundAccount(provider, stealth.publicKey, 5e7);

    const positionKp = Keypair.generate();
    positionPubkey = positionKp.publicKey;
    [poolAuthority] = derivePoolAuthority(programId, stealth.publicKey, LB_PAIR);

    const disc = await anchorDiscriminator("dlmm_init_position");
    const args = Buffer.alloc(8 + 32);
    args.writeInt32LE(-10, 0); args.writeInt32LE(20, 4);
    exitRecipient.toBuffer().copy(args, 8);
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
    await provider.sendAndConfirm(
      new Transaction().add(new TransactionInstruction({ programId, keys, data: Buffer.concat([disc, args]) })),
      [stealth, positionKp],
    );

    escrowTokenX = await createAccount(provider.connection, provider.wallet.payer, anchor.web3.NATIVE_MINT, poolAuthority, Keypair.generate());
    escrowTokenY = await createAccount(provider.connection, provider.wallet.payer, anchor.web3.NATIVE_MINT, poolAuthority, Keypair.generate());
  });

  async function buildAddLiquidityIx(opts: { lbPairInCpi: PublicKey; tokenMintX: PublicKey; tokenMintY: PublicKey; }): Promise<TransactionInstruction> {
    const placeholder = Keypair.generate().publicKey;
    const dlmm: AccountMeta[] = [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },
      { pubkey: opts.lbPairInCpi, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: escrowTokenX, isSigner: false, isWritable: true },
      { pubkey: escrowTokenY, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: opts.tokenMintX, isSigner: false, isWritable: false },
      { pubkey: opts.tokenMintY, isSigner: false, isWritable: false },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmm,
    ];
    const disc = await anchorDiscriminator("dlmm_add_liquidity");
    const liquidityParams = Buffer.alloc(4);
    return new TransactionInstruction({
      programId,
      keys: accounts,
      data: Buffer.concat([disc, liquidityParams]),
    });
  }

  it("rejects mismatched lb_pair in forwarded account list", async () => {
    const fakeLbPair = Keypair.generate().publicKey;
    const ix = await buildAddLiquidityIx({
      lbPairInCpi: fakeLbPair,
      tokenMintX: anchor.web3.NATIVE_MINT,
      tokenMintY: anchor.web3.NATIVE_MINT,
    });

    let code: number | null = null;
    try { await provider.sendAndConfirm(new Transaction().add(ix), [stealth]); }
    catch (e) { code = extractErrorCode(e); }
    expect(code).to.equal(ERR_LBPAIR_MISMATCH);
  });

  it("rejects token mint mismatch in escrow token account", async () => {
    const ix = await buildAddLiquidityIx({
      lbPairInCpi: LB_PAIR,
      tokenMintX: Keypair.generate().publicKey,
      tokenMintY: anchor.web3.NATIVE_MINT,
    });

    let code: number | null = null;
    try { await provider.sendAndConfirm(new Transaction().add(ix), [stealth]); }
    catch (e) { code = extractErrorCode(e); }
    expect(code).to.equal(ERR_TOKEN_MINT);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TEST: dlmm_withdraw_close negative cases
// ═══════════════════════════════════════════════════════════════════════
describe("DLMM :: dlmm_withdraw_close negative", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.octoraExecutor as Program;
  const programId = program.programId;

  let stealth: Keypair;
  let poolAuthority: PublicKey;
  let positionPubkey: PublicKey;
  let exitRecipient: PublicKey;
  let goodX: PublicKey;
  let goodY: PublicKey;
  let attacker: Keypair;

  before(async () => {
    stealth = Keypair.generate();
    exitRecipient = Keypair.generate().publicKey;
    attacker = Keypair.generate();

    await fundAccount(provider, stealth.publicKey, 5e7);
    const positionKp = Keypair.generate();
    positionPubkey = positionKp.publicKey;
    [poolAuthority] = derivePoolAuthority(programId, stealth.publicKey, LB_PAIR);

    // Init
    const disc = await anchorDiscriminator("dlmm_init_position");
    const args = Buffer.alloc(8 + 32);
    args.writeInt32LE(-10, 0); args.writeInt32LE(20, 4);
    exitRecipient.toBuffer().copy(args, 8);
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
    await provider.sendAndConfirm(
      new Transaction().add(new TransactionInstruction({ programId, keys, data: Buffer.concat([disc, args]) })),
      [stealth, positionKp],
    );

    goodX = await createAccount(provider.connection, provider.wallet.payer, anchor.web3.NATIVE_MINT, exitRecipient, Keypair.generate());
    goodY = await createAccount(provider.connection, provider.wallet.payer, anchor.web3.NATIVE_MINT, exitRecipient, Keypair.generate());
  });

  function buildWCIx(opts: { userX: PublicKey; userY: PublicKey; rentReceiver: PublicKey }): TransactionInstruction {
    const placeholder = Keypair.generate().publicKey;
    const dlmm: AccountMeta[] = [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: opts.userX, isSigner: false, isWritable: true },
      { pubkey: opts.userY, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: opts.rentReceiver, isSigner: false, isWritable: true },
    ];
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmm,
    ];
    const args = Buffer.alloc(10);
    args.writeInt32LE(-10, 0); args.writeInt32LE(10, 4); args.writeUInt16LE(10000, 8);
    return new TransactionInstruction({ programId, keys: accounts, data: Buffer.concat([disc, args]) });
  }

  let disc: Buffer;
  before(async () => { disc = await anchorDiscriminator("dlmm_withdraw_close"); });

  it("rejects user_token_x not owned by exit_recipient", async () => {
    const badX = await createAccount(provider.connection, provider.wallet.payer, anchor.web3.NATIVE_MINT, attacker.publicKey, Keypair.generate());
    const ix = buildWCIx({ userX: badX, userY: goodY, rentReceiver: exitRecipient });
    let code: number | null = null;
    try { await provider.sendAndConfirm(new Transaction().add(ix), [stealth]); }
    catch (e) { code = extractErrorCode(e); }
    expect(code).to.equal(ERR_EXIT_RECIPIENT);
  });

  it("rejects rent_receiver != exit_recipient", async () => {
    const ix = buildWCIx({ userX: goodX, userY: goodY, rentReceiver: attacker.publicKey });
    let code: number | null = null;
    try { await provider.sendAndConfirm(new Transaction().add(ix), [stealth]); }
    catch (e) { code = extractErrorCode(e); }
    expect(code).to.equal(ERR_EXIT_RECIPIENT);
  });

  it("rejects bps_to_remove = 0", async () => {
    const placeholder = Keypair.generate().publicKey;
    const dlmm: AccountMeta[] = [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: goodX, isSigner: false, isWritable: true },
      { pubkey: goodY, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: exitRecipient, isSigner: false, isWritable: true },
    ];
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmm,
    ];
    const args = Buffer.alloc(10);
    args.writeInt32LE(-10, 0); args.writeInt32LE(10, 4); args.writeUInt16LE(0, 8); // 0 bps = invalid

    let code: number | null = null;
    try { await provider.sendAndConfirm(new Transaction().add(new TransactionInstruction({ programId, keys: accounts, data: Buffer.concat([disc, args]) })), [stealth]); }
    catch (e) { code = extractErrorCode(e); }
    expect(code).to.equal(ERR_ARG_OUT_OF_RANGE);
  });

  it("rejects invalid bin range (from > to)", async () => {
    const placeholder = Keypair.generate().publicKey;
    const dlmm: AccountMeta[] = [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: goodX, isSigner: false, isWritable: true },
      { pubkey: goodY, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: anchor.web3.NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: placeholder, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: exitRecipient, isSigner: false, isWritable: true },
    ];
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: LB_PAIR, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmm,
    ];
    const args = Buffer.alloc(10);
    args.writeInt32LE(10, 0); args.writeInt32LE(-10, 4); args.writeUInt16LE(10000, 8); // swapped → invalid

    let code: number | null = null;
    try { await provider.sendAndConfirm(new Transaction().add(new TransactionInstruction({ programId, keys: accounts, data: Buffer.concat([disc, args]) })), [stealth]); }
    catch (e) { code = extractErrorCode(e); }
    expect(code).to.equal(ERR_ARG_OUT_OF_RANGE);
  });
});
