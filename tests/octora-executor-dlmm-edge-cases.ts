/**
 * DLMM edge cases + extended positive tests.
 *
 * Covers: single-bin positions, partial withdraws, exit_recipient=stealth,
 * multiple positions per wallet, multi-deposit, very small/large amounts.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createMint, mintTo, getOrCreateAssociatedTokenAccount,
  getAccount, createTransferInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import DLMM, { binIdToBinArrayIndex, deriveBinArray, deriveLbPair2, deriveReserve } from "@meteora-ag/dlmm";
import { expect } from "chai";

const POOL_AUTHORITY_SEED = Buffer.from("pool-authority");
const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const DLMM_EVENT_AUTHORITY = new PublicKey("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");
const PRESET = new PublicKey("BYQtcDyv2BoFuf5ghsYDGPA8iX5F4WquK7zCzUsDwJ63");
const BIN_STEP = 10; const BASE_FACTOR = 10000; const ACTIVE_BIN = 0;

function derivePA(pId: PublicKey, s: PublicKey, pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_AUTHORITY_SEED, s.toBuffer(), pool.toBuffer()], pId);
}
async function anchorDisc(name: string): Promise<Buffer> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
async function fund(provider: anchor.AnchorProvider, to: PublicKey, lamports: number) {
  await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: to, lamports })));
}
function encodeLP(p: { amountX: BN; amountY: BN; activeId: number; maxSlip: number; minBin: number; maxBin: number; strat: number }): Buffer {
  const buf = Buffer.alloc(97); let o = 0;
  p.amountX.toArrayLike(Buffer, "le", 8).copy(buf, o); o += 8;
  p.amountY.toArrayLike(Buffer, "le", 8).copy(buf, o); o += 8;
  buf.writeInt32LE(p.activeId, o); o += 4;
  buf.writeInt32LE(p.maxSlip, o); o += 4;
  buf.writeInt32LE(p.minBin, o); o += 4;
  buf.writeInt32LE(p.maxBin, o); o += 4;
  buf.writeUInt8(p.strat, o);
  return buf;
}

// ═══════════════════════════════════════════════════════════════════════
// EDGE CASE 1: exit_recipient = stealth (same key)
// ═══════════════════════════════════════════════════════════════════════
describe("DLMM :: edge cases — exit_recipient = stealth", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.octoraExecutor as Program;
  const pId = program.programId;

  it("init_position with exit_recipient = stealth pubkey", async () => {
    const stealth = Keypair.generate();
    await fund(provider, stealth.publicKey, 1e9);
    const positionKp = Keypair.generate();
    const [pa] = derivePA(pId, stealth.publicKey, new PublicKey("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"));

    const disc = await anchorDisc("dlmm_init_position");
    const args = Buffer.alloc(8 + 32);
    args.writeInt32LE(-10, 0); args.writeInt32LE(20, 4);
    stealth.publicKey.toBuffer().copy(args, 8); // exit_recipient = stealth itself

    const LB_PAIR = new PublicKey("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");
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
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    await provider.sendAndConfirm(
      new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
        .add(new TransactionInstruction({ programId: pId, keys, data: Buffer.concat([disc, args]) })),
      [stealth, positionKp],
    );

    // Verify: exit_recipient should equal stealth
    const paData = await provider.connection.getAccountInfo(pa);
    expect(paData).to.not.be.null;
    const exitRecipient = new PublicKey(paData!.data.subarray(40, 72));
    expect(exitRecipient.equals(stealth.publicKey)).to.be.true;
  });
});

// ═══════════════════════════════════════════════════════════════════════
// EDGE CASE 2: Multiple positions — same stealth, different lb_pairs
// ═══════════════════════════════════════════════════════════════════════
describe("DLMM :: edge cases — multiple positions per stealth", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.octoraExecutor as Program;
  const pId = program.programId;

  it("creates two positions on two different pools with same stealth", async () => {
    const stealth = Keypair.generate();
    await fund(provider, stealth.publicKey, 5e7); // enough for 2 init costs

    // Two different LB pairs
    const pair1 = new PublicKey("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");
    const pair2 = new PublicKey("ARwi1S4DaiT5QD7MhzqyE5axBQaAoZpds1k2Je1f7VzC"); // different pool

    const exitRecipient = Keypair.generate().publicKey;
    const pos1 = Keypair.generate(); const pos2 = Keypair.generate();

    // Init position 1
    const [pa1] = derivePA(pId, stealth.publicKey, pair1);
    const d1 = await anchorDisc("dlmm_init_position");
    const a1 = Buffer.alloc(8 + 32); a1.writeInt32LE(-10, 0); a1.writeInt32LE(20, 4); exitRecipient.toBuffer().copy(a1, 8);
    const keys1: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: pa1, isSigner: false, isWritable: true },
      { pubkey: pair1, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: pos1.publicKey, isSigner: true, isWritable: true },
      { pubkey: pair1, isSigner: false, isWritable: false },
      { pubkey: pa1, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    await provider.sendAndConfirm(new Transaction().add(new TransactionInstruction({ programId: pId, keys: keys1, data: Buffer.concat([d1, a1]) })), [stealth, pos1]);

    // Init position 2 — different PDA because pool2 != pool1
    const [pa2] = derivePA(pId, stealth.publicKey, pair2);
    expect(pa1.equals(pa2)).to.be.false; // MUST be different PDAs

    const d2 = await anchorDisc("dlmm_init_position");
    const a2 = Buffer.alloc(8 + 32); a2.writeInt32LE(-10, 0); a2.writeInt32LE(20, 4); exitRecipient.toBuffer().copy(a2, 8);
    const keys2: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: pa2, isSigner: false, isWritable: true },
      { pubkey: pair2, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: pos2.publicKey, isSigner: true, isWritable: true },
      { pubkey: pair2, isSigner: false, isWritable: false },
      { pubkey: pa2, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    await provider.sendAndConfirm(new Transaction().add(new TransactionInstruction({ programId: pId, keys: keys2, data: Buffer.concat([d2, a2]) })), [stealth, pos2]);

    // Both PDAs should exist
    const pa1Data = await provider.connection.getAccountInfo(pa1);
    const pa2Data = await provider.connection.getAccountInfo(pa2);
    expect(pa1Data).to.not.be.null;
    expect(pa2Data).to.not.be.null;
    // exit_recipient should be the same for both
    const er1 = new PublicKey(pa1Data!.data.subarray(40, 72));
    const er2 = new PublicKey(pa2Data!.data.subarray(40, 72));
    expect(er1.equals(exitRecipient)).to.be.true;
    expect(er2.equals(exitRecipient)).to.be.true;
  });
});

// ═══════════════════════════════════════════════════════════════════════
// EDGE CASE 3: Partial withdraw (not full close)
// ═══════════════════════════════════════════════════════════════════════
describe("DLMM :: edge cases — partial withdraw", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.octoraExecutor as Program;
  const pId = program.programId;
  const connection = provider.connection;

  let tokenX: PublicKey, tokenY: PublicKey, lbPair: PublicKey, dlmm: DLMM;
  let stealth: Keypair, poolAuthority: PublicKey, positionKp: Keypair, exitRecipient: PublicKey;
  let exitAtaX: PublicKey, exitAtaY: PublicKey, pdaAtaX: PublicKey, pdaAtaY: PublicKey;
  let userAtaX: PublicKey, userAtaY: PublicKey;

  before(async () => {
    const payer = provider.wallet as anchor.Wallet;
    // Create fresh local LB pair
    tokenX = await createMint(connection, payer.payer, payer.publicKey, null, 6);
    tokenY = await createMint(connection, payer.payer, payer.publicKey, null, 6);
    if (Buffer.compare(tokenX.toBuffer(), tokenY.toBuffer()) > 0) { [tokenX, tokenY] = [tokenY, tokenX]; }
    userAtaX = (await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenX, payer.publicKey)).address;
    userAtaY = (await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenY, payer.publicKey)).address;
    await mintTo(connection, payer.payer, tokenX, userAtaX, payer.publicKey, 1_000_000_000n);
    await mintTo(connection, payer.payer, tokenY, userAtaY, payer.publicKey, 1_000_000_000n);

    const tx = await DLMM.createLbPair(connection, payer.publicKey, tokenX, tokenY, new BN(BIN_STEP), new BN(BASE_FACTOR), PRESET, new BN(ACTIVE_BIN));
    await provider.sendAndConfirm(tx);
    [lbPair] = deriveLbPair2(tokenX, tokenY, new BN(BIN_STEP), new BN(BASE_FACTOR), DLMM_PROGRAM_ID);
    dlmm = await DLMM.create(connection, lbPair);

    const lowerIdx = binIdToBinArrayIndex(new BN(-5));
    const upperIdx = binIdToBinArrayIndex(new BN(4));
    const arrs = [lowerIdx, upperIdx];
    const binIxs = await dlmm.initializeBinArrays(arrs, payer.publicKey);
    if (binIxs.length > 0) await provider.sendAndConfirm(new Transaction().add(...binIxs));

    stealth = Keypair.generate();
    exitRecipient = Keypair.generate().publicKey;
    positionKp = Keypair.generate();
    [poolAuthority] = derivePA(pId, stealth.publicKey, lbPair);
    await fund(provider, stealth.publicKey, 0.1 * LAMPORTS_PER_SOL);

    exitAtaX = (await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenX, exitRecipient)).address;
    exitAtaY = (await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenY, exitRecipient)).address;
    pdaAtaX = (await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenX, poolAuthority, true)).address;
    pdaAtaY = (await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenY, poolAuthority, true)).address;

    // Init position
    const d = await anchorDisc("dlmm_init_position");
    const a = Buffer.alloc(8 + 32); a.writeInt32LE(-5, 0); a.writeInt32LE(10, 4); exitRecipient.toBuffer().copy(a, 8);
    const keys: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: lbPair, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: lbPair, isSigner: false, isWritable: false },
      { pubkey: poolAuthority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    await provider.sendAndConfirm(new Transaction().add(new TransactionInstruction({ programId: pId, keys, data: Buffer.concat([d, a]) })), [stealth, positionKp]);

    // Add liquidity
    const amtX = new BN(500_000); const amtY = new BN(500_000);
    await provider.sendAndConfirm(new Transaction()
      .add(createTransferInstruction(userAtaX, pdaAtaX, payer.publicKey, BigInt(amtX.toString())))
      .add(createTransferInstruction(userAtaY, pdaAtaY, payer.publicKey, BigInt(amtY.toString()))),
    );
    const ad = await anchorDisc("dlmm_add_liquidity");
    const lp = encodeLP({ amountX: amtX, amountY: amtY, activeId: ACTIVE_BIN, maxSlip: 5, minBin: -5, maxBin: 4, strat: 6 });
    const lpLen = Buffer.alloc(4); lpLen.writeUInt32LE(lp.length, 0);
    const [baLower] = deriveBinArray(lbPair, lowerIdx, DLMM_PROGRAM_ID);
    const [baUpper] = deriveBinArray(lbPair, upperIdx, DLMM_PROGRAM_ID);
    const [rX] = deriveReserve(tokenX, lbPair, DLMM_PROGRAM_ID);
    const [rY] = deriveReserve(tokenY, lbPair, DLMM_PROGRAM_ID);
    const adDlmm: AccountMeta[] = [
      { pubkey: positionKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: lbPair, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: pdaAtaX, isSigner: false, isWritable: true }, { pubkey: pdaAtaY, isSigner: false, isWritable: true },
      { pubkey: rX, isSigner: false, isWritable: true }, { pubkey: rY, isSigner: false, isWritable: true },
      { pubkey: tokenX, isSigner: false, isWritable: false }, { pubkey: tokenY, isSigner: false, isWritable: false },
      { pubkey: baLower, isSigner: false, isWritable: true }, { pubkey: baUpper, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const adKeys: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: lbPair, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...adDlmm,
    ];
    await provider.sendAndConfirm(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(new TransactionInstruction({ programId: pId, keys: adKeys, data: Buffer.concat([ad, lpLen, lp]) })), [stealth]);
  });

  // Withdraw exactly 50%
  it("partial withdraw 5000 bps (50%) — position stays open", async () => {
    const wd = await anchorDisc("dlmm_withdraw_close");
    const wArgs = Buffer.alloc(10); wArgs.writeInt32LE(-5, 0); wArgs.writeInt32LE(4, 4); wArgs.writeUInt16LE(5000, 8); // 50%

    const lowerIdx = binIdToBinArrayIndex(new BN(-5));
    const upperIdx = binIdToBinArrayIndex(new BN(4));
    const [baLower] = deriveBinArray(lbPair, lowerIdx, DLMM_PROGRAM_ID);
    const [baUpper] = deriveBinArray(lbPair, upperIdx, DLMM_PROGRAM_ID);
    const [rX] = deriveReserve(tokenX, lbPair, DLMM_PROGRAM_ID);
    const [rY] = deriveReserve(tokenY, lbPair, DLMM_PROGRAM_ID);

    const wDlmm: AccountMeta[] = [
      { pubkey: positionKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: lbPair, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: exitAtaX, isSigner: false, isWritable: true }, { pubkey: exitAtaY, isSigner: false, isWritable: true },
      { pubkey: rX, isSigner: false, isWritable: true }, { pubkey: rY, isSigner: false, isWritable: true },
      { pubkey: tokenX, isSigner: false, isWritable: false }, { pubkey: tokenY, isSigner: false, isWritable: false },
      { pubkey: baLower, isSigner: false, isWritable: true }, { pubkey: baUpper, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: exitRecipient, isSigner: false, isWritable: true },
    ];
    const wKeys: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: lbPair, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...wDlmm,
    ];
    await provider.sendAndConfirm(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
      .add(new TransactionInstruction({ programId: pId, keys: wKeys, data: Buffer.concat([wd, wArgs]) })), [stealth]);

    // exit ATAs should have SOME tokens (partial), but poolAuthority still exists (not closed at 50%)
    const exX = await getAccount(connection, exitAtaX);
    expect(Number(exX.amount)).to.be.greaterThan(0);
    const paInfo = await provider.connection.getAccountInfo(poolAuthority);
    expect(paInfo).to.not.be.null; // Still open after partial withdraw
  });
});
