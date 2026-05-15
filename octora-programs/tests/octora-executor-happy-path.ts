/**
 * Full happy-path lifecycle: dlmm_init_position → dlmm_add_liquidity →
 * dlmm_withdraw_close. Uses a fresh local LB pair with local mints.
 */

import * as anchor from "@coral-xyz/anchor";
import { BorshCoder, Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  createTransferInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import DLMM, {
  binIdToBinArrayIndex,
  deriveBinArray,
  deriveLbPair2,
  deriveReserve,
  deriveOracle,
  StrategyType,
} from "@meteora-ag/dlmm";
import { expect } from "chai";

// ─── Constants ─────────────────────────────────────────────────────────

const POOL_AUTHORITY_SEED = Buffer.from("pool-authority");
const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);
const DLMM_EVENT_AUTHORITY = new PublicKey(
  "D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6",
);
const PRESET_PARAMETER = new PublicKey(
  "BYQtcDyv2BoFuf5ghsYDGPA8iX5F4WquK7zCzUsDwJ63",
);
const BASE_FACTOR = 10000;
const BIN_STEP = 10;
const ACTIVE_BIN = 0;
const LOWER_BIN_ID = -10;
const POSITION_WIDTH = 20;
const UPPER_BIN_ID = LOWER_BIN_ID + POSITION_WIDTH - 1;

// ─── Helpers ───────────────────────────────────────────────────────────

function derivePoolAuthority(
  programId: PublicKey,
  stealth: PublicKey,
  lbPair: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POOL_AUTHORITY_SEED, stealth.toBuffer(), lbPair.toBuffer()],
    programId,
  );
}

async function anchorDiscriminator(name: string): Promise<Buffer> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
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

function encodeLiquidityParamsByStrategy(p: {
  amountX: BN;
  amountY: BN;
  activeId: number;
  maxActiveBinSlippage: number;
  minBinId: number;
  maxBinId: number;
  strategyType: number;
}): Buffer {
  const buf = Buffer.alloc(97);
  let o = 0;
  p.amountX.toArrayLike(Buffer, "le", 8).copy(buf, o); o += 8;
  p.amountY.toArrayLike(Buffer, "le", 8).copy(buf, o); o += 8;
  buf.writeInt32LE(p.activeId, o); o += 4;
  buf.writeInt32LE(p.maxActiveBinSlippage, o); o += 4;
  buf.writeInt32LE(p.minBinId, o); o += 4;
  buf.writeInt32LE(p.maxBinId, o); o += 4;
  buf.writeUInt8(p.strategyType, o); o += 1;
  return buf;
}

// ═══════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════

describe("octora-executor :: happy path lifecycle (fresh local LB pair)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.octoraExecutor as Program;
  const programId = program.programId;
  const payer = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  let tokenX: PublicKey;
  let tokenY: PublicKey;
  let lbPair: PublicKey;
  let dlmm: DLMM;
  let userAtaX: PublicKey;
  let userAtaY: PublicKey;

  // Per-test stealth + position
  let stealth: Keypair;
  let poolAuthority: PublicKey;
  let positionKeypair: Keypair;
  let exitRecipient: PublicKey;
  let exitAtaX: PublicKey;
  let exitAtaY: PublicKey;

  // PDA-owned escrow ATAs.
  let pdaAtaX: PublicKey;
  let pdaAtaY: PublicKey;

  before(async () => {
    // ── Fresh mints ─────────────────────────────────────────────
    tokenX = await createMint(connection, payer.payer, payer.publicKey, null, 6);
    tokenY = await createMint(connection, payer.payer, payer.publicKey, null, 6);

    // sortTokenMints
    if (Buffer.compare(tokenX.toBuffer(), tokenY.toBuffer()) > 0) {
      const tmp = tokenX;
      tokenX = tokenY;
      tokenY = tmp;
    }

    // User ATAs + balances
    userAtaX = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenX, payer.publicKey)
    ).address;
    userAtaY = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenY, payer.publicKey)
    ).address;
    await mintTo(connection, payer.payer, tokenX, userAtaX, payer.publicKey, 1_000_000_000n);
    await mintTo(connection, payer.payer, tokenY, userAtaY, payer.publicKey, 1_000_000_000n);

    // ── Create LB pair via DLMM SDK ─────────────────────────────
    const createPairTx = await DLMM.createLbPair(
      connection,
      payer.publicKey,
      tokenX,
      tokenY,
      new BN(BIN_STEP),
      new BN(BASE_FACTOR),
      PRESET_PARAMETER,
      new BN(ACTIVE_BIN),
    );
    await provider.sendAndConfirm(createPairTx);

    [lbPair] = deriveLbPair2(tokenX, tokenY, new BN(BIN_STEP), new BN(BASE_FACTOR), DLMM_PROGRAM_ID);
    dlmm = await DLMM.create(connection, lbPair);

    // ── Initialise the bin arrays ────────
    const lowerArrayIdx = binIdToBinArrayIndex(new BN(LOWER_BIN_ID));
    const upperArrayIdx = binIdToBinArrayIndex(new BN(UPPER_BIN_ID));
    const uniqueArrayIdxs =
      lowerArrayIdx.eq(upperArrayIdx) ? [lowerArrayIdx] : [lowerArrayIdx, upperArrayIdx];
    const binArrayIxs = await dlmm.initializeBinArrays(uniqueArrayIdxs, payer.publicKey);
    if (binArrayIxs.length > 0) {
      await provider.sendAndConfirm(new Transaction().add(...binArrayIxs));
    }

    // ── Stealth + position bookkeeping ──
    stealth = Keypair.generate();
    exitRecipient = Keypair.generate().publicKey;
    [poolAuthority] = derivePoolAuthority(programId, stealth.publicKey, lbPair);
    positionKeypair = Keypair.generate();

    // exit_recipient ATAs
    exitAtaX = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenX, exitRecipient)
    ).address;
    exitAtaY = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenY, exitRecipient)
    ).address;

    // PDA-owned ATAs — allowOwnerOffCurve=true because poolAuthority is a PDA
    pdaAtaX = (
      await getOrCreateAssociatedTokenAccount(
        connection, payer.payer, tokenX, poolAuthority, true,
      )
    ).address;
    pdaAtaY = (
      await getOrCreateAssociatedTokenAccount(
        connection, payer.payer, tokenY, poolAuthority, true,
      )
    ).address;

    await fundLamports(provider, stealth.publicKey, 0.05 * anchor.web3.LAMPORTS_PER_SOL);
  });

  it("dlmm_init_position via executor", async () => {
    const disc = await anchorDiscriminator("dlmm_init_position");
    // Args: lower_bin_id (i32) + width (i32) + exit_recipient (Pubkey = 32 bytes)
    const args = Buffer.alloc(8 + 32);
    args.writeInt32LE(LOWER_BIN_ID, 0);
    args.writeInt32LE(POSITION_WIDTH, 4);
    exitRecipient.toBuffer().copy(args, 8);

    // DLMM accounts (8 remaining)
    const dlmmAccounts: AccountMeta[] = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: lbPair, isSigner: false, isWritable: false },
      { pubkey: poolAuthority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    // Executor accounts: stealth(mut), pool_authority, lb_pair, dlmm_program, system_program
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: lbPair, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...dlmmAccounts,
    ];

    await provider.sendAndConfirm(
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
        .add(new TransactionInstruction({ programId, keys: accounts, data: Buffer.concat([disc, args]) })),
      [stealth, positionKeypair],
    );

    const positionInfo = await connection.getAccountInfo(positionKeypair.publicKey);
    expect(positionInfo, "position account").to.not.be.null;
    expect(positionInfo!.owner.toBase58()).to.equal(DLMM_PROGRAM_ID.toBase58());
  });

  it("dlmm_add_liquidity via executor (spotImBalanced strategy)", async () => {
    // Move funds from user ATAs into the PDA-owned escrow ATAs.
    const amountX = new BN(100);
    const amountY = new BN(100);
    await provider.sendAndConfirm(
      new Transaction()
        .add(createTransferInstruction(userAtaX, pdaAtaX, payer.publicKey, BigInt(amountX.toString())))
        .add(createTransferInstruction(userAtaY, pdaAtaY, payer.publicKey, BigInt(amountY.toString()))),
    );

    const disc = await anchorDiscriminator("dlmm_add_liquidity");

    const liquidityParams = encodeLiquidityParamsByStrategy({
      amountX,
      amountY,
      activeId: ACTIVE_BIN,
      maxActiveBinSlippage: 5,
      minBinId: LOWER_BIN_ID,
      maxBinId: UPPER_BIN_ID,
      strategyType: 6, // spotImBalanced
    });

    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32LE(liquidityParams.length, 0);
    const data = Buffer.concat([disc, lenPrefix, liquidityParams]);

    const lowerArrayIdx = binIdToBinArrayIndex(new BN(LOWER_BIN_ID));
    const upperArrayIdx = binIdToBinArrayIndex(new BN(UPPER_BIN_ID));
    const [binArrayLower] = deriveBinArray(lbPair, lowerArrayIdx, DLMM_PROGRAM_ID);
    const [binArrayUpper] = deriveBinArray(lbPair, upperArrayIdx, DLMM_PROGRAM_ID);
    const [reserveX] = deriveReserve(tokenX, lbPair, DLMM_PROGRAM_ID);
    const [reserveY] = deriveReserve(tokenY, lbPair, DLMM_PROGRAM_ID);

    const dlmmAccounts: AccountMeta[] = [
      { pubkey: positionKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: lbPair, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: pdaAtaX, isSigner: false, isWritable: true },
      { pubkey: pdaAtaY, isSigner: false, isWritable: true },
      { pubkey: reserveX, isSigner: false, isWritable: true },
      { pubkey: reserveY, isSigner: false, isWritable: true },
      { pubkey: tokenX, isSigner: false, isWritable: false },
      { pubkey: tokenY, isSigner: false, isWritable: false },
      { pubkey: binArrayLower, isSigner: false, isWritable: true },
      { pubkey: binArrayUpper, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    // Executor: stealth, pool_authority, lb_pair, dlmm_program
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: lbPair, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmmAccounts,
    ];

    await provider.sendAndConfirm(
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(new TransactionInstruction({ programId, keys: accounts, data })),
      [stealth],
    );

    const reserveXAcct = await getAccount(connection, reserveX);
    const reserveYAcct = await getAccount(connection, reserveY);
    expect(Number(reserveXAcct.amount)).to.be.greaterThan(0);
    expect(Number(reserveXAcct.amount)).to.be.at.most(100);
    expect(Number(reserveYAcct.amount)).to.be.greaterThan(0);
    expect(Number(reserveYAcct.amount)).to.be.at.most(100);

    const pdaXAfter = await getAccount(connection, pdaAtaX);
    expect(Number(pdaXAfter.amount)).to.be.at.most(100);
  });

  it("dlmm_withdraw_close via executor: tokens flow back to exit_recipient", async () => {
    const disc = await anchorDiscriminator("dlmm_withdraw_close");

    const args = Buffer.alloc(10);
    args.writeInt32LE(LOWER_BIN_ID, 0);
    args.writeInt32LE(UPPER_BIN_ID, 4);
    args.writeUInt16LE(10000, 8);

    const lowerArrayIdx = binIdToBinArrayIndex(new BN(LOWER_BIN_ID));
    const upperArrayIdx = binIdToBinArrayIndex(new BN(UPPER_BIN_ID));
    const [binArrayLower] = deriveBinArray(lbPair, lowerArrayIdx, DLMM_PROGRAM_ID);
    const [binArrayUpper] = deriveBinArray(lbPair, upperArrayIdx, DLMM_PROGRAM_ID);
    const [reserveX] = deriveReserve(tokenX, lbPair, DLMM_PROGRAM_ID);
    const [reserveY] = deriveReserve(tokenY, lbPair, DLMM_PROGRAM_ID);

    const dlmmAccounts: AccountMeta[] = [
      { pubkey: positionKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: lbPair, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },
      { pubkey: exitAtaX, isSigner: false, isWritable: true },
      { pubkey: exitAtaY, isSigner: false, isWritable: true },
      { pubkey: reserveX, isSigner: false, isWritable: true },
      { pubkey: reserveY, isSigner: false, isWritable: true },
      { pubkey: tokenX, isSigner: false, isWritable: false },
      { pubkey: tokenY, isSigner: false, isWritable: false },
      { pubkey: binArrayLower, isSigner: false, isWritable: true },
      { pubkey: binArrayUpper, isSigner: false, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: exitRecipient, isSigner: false, isWritable: true },
    ];

    // Executor: stealth(mut), pool_authority, lb_pair, dlmm_program
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: lbPair, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmmAccounts,
    ];

    await provider.sendAndConfirm(
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(new TransactionInstruction({ programId, keys: accounts, data: Buffer.concat([disc, args]) })),
      [stealth],
    );

    const exitX = await getAccount(connection, exitAtaX);
    const exitY = await getAccount(connection, exitAtaY);
    expect(Number(exitX.amount), "exit ATA X balance").to.be.greaterThan(0);
    expect(Number(exitY.amount), "exit ATA Y balance").to.be.greaterThan(0);

    const positionInfo = await connection.getAccountInfo(positionKeypair.publicKey);
    expect(positionInfo, "position account closed").to.be.null;

    const paInfo = await connection.getAccountInfo(poolAuthority);
    expect(paInfo, "PoolAuthority closed").to.be.null;
  });
});
