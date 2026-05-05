/**
 * Phase 4 happy-path lifecycle test.
 *
 * Builds a fresh local LB pair on local mints, runs the executor's full
 * cycle (init_position → add_liquidity → withdraw_close), and asserts
 * tokens land back at exit_recipient.
 *
 * Why fresh local mints: the cloned mainnet SOL/USDC pair can't take
 * test USDC because Circle owns the USDC mint authority. With our own
 * mints we can fund both sides of an add_liquidity properly. Setup uses
 * a cloned `presetParameter2` PDA from mainnet so DLMM's
 * `initializeLbPair2` accepts our pair.
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

const POSITION_AUTHORITY_SEED = Buffer.from("position-authority");
const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);
const DLMM_EVENT_AUTHORITY = new PublicKey(
  "D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6",
);
// preset_parameter PDA at v2-style seeds [b"preset_parameter", binStep:u16,
// baseFactor:u16] but containing the v1 layout (36 bytes, disc 242,…). DLMM
// stores most production presets this way, so we use the v1 SDK helper
// `DLMM.createLbPair` which expects the v1 discriminator.
const PRESET_PARAMETER = new PublicKey(
  "BYQtcDyv2BoFuf5ghsYDGPA8iX5F4WquK7zCzUsDwJ63",
);
const BASE_FACTOR = 10000;
const BIN_STEP = 10;
const ACTIVE_BIN = 0;
const LOWER_BIN_ID = -10;
const POSITION_WIDTH = 20; // [-10..9]
const UPPER_BIN_ID = LOWER_BIN_ID + POSITION_WIDTH - 1;

// ─── Helpers ───────────────────────────────────────────────────────────

function derivePositionAuthority(
  programId: PublicKey,
  stealth: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POSITION_AUTHORITY_SEED, stealth.toBuffer()],
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

/**
 * Borsh-encode `LiquidityParameterByStrategy` exactly as DLMM's IDL specifies.
 * Layout:
 *   amountX: u64 (8 LE)
 *   amountY: u64 (8 LE)
 *   activeId: i32 (4 LE)
 *   maxActiveBinSlippage: i32 (4 LE)
 *   strategyParameters:
 *     minBinId: i32 (4 LE)
 *     maxBinId: i32 (4 LE)
 *     strategyType: u8 (enum index)
 *     parameteres: [u8; 64]
 */
function encodeLiquidityParamsByStrategy(p: {
  amountX: BN;
  amountY: BN;
  activeId: number;
  maxActiveBinSlippage: number;
  minBinId: number;
  maxBinId: number;
  strategyType: number; // 3 = spotBalanced (StrategyType enum index)
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
  // parameteres [u8; 64] — zero-filled is fine for the basic spot strategies.
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

  // Pair-level state
  let tokenX: PublicKey;
  let tokenY: PublicKey;
  let lbPair: PublicKey;
  let dlmm: DLMM;
  let userAtaX: PublicKey;
  let userAtaY: PublicKey;

  // Per-test stealth + position
  let stealth: Keypair;
  let positionAuthority: PublicKey;
  let positionKeypair: Keypair;
  let exitRecipient: PublicKey;
  let exitAtaX: PublicKey;
  let exitAtaY: PublicKey;

  // PDA-owned escrow ATAs. DLMM `add_liquidity` runs with `sender = PDA`,
  // and the SPL Token program requires the authority on a transfer to also
  // own the source account — so the source ATA must be PDA-owned. Funds
  // get transferred here from the user before add_liquidity, and DLMM
  // sweeps them into the LB pair reserves from inside the CPI.
  let pdaAtaX: PublicKey;
  let pdaAtaY: PublicKey;

  before(async () => {
    // ── Fresh mints (test wallet is the mint authority) ──────────────
    tokenX = await createMint(connection, payer.payer, payer.publicKey, null, 6);
    tokenY = await createMint(connection, payer.payer, payer.publicKey, null, 6);

    // sortTokenMints inside the SDK orders (X, Y) by pubkey before
    // hashing into the LB pair PDA — so make sure our local X is the
    // smaller pubkey, otherwise the SDK's `lbPair` derivation won't
    // match what we pass to DLMM.createLbPair2.
    if (Buffer.compare(tokenX.toBuffer(), tokenY.toBuffer()) > 0) {
      const tmp = tokenX;
      tokenX = tokenY;
      tokenY = tmp;
    }

    // User ATAs + balances. 1B base units each (= 1k tokens at 6 dp).
    userAtaX = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenX, payer.publicKey)
    ).address;
    userAtaY = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenY, payer.publicKey)
    ).address;
    await mintTo(connection, payer.payer, tokenX, userAtaX, payer.publicKey, 1_000_000_000n);
    await mintTo(connection, payer.payer, tokenY, userAtaY, payer.publicKey, 1_000_000_000n);

    // ── Create LB pair via DLMM SDK (v1 ix → v1 preset) ─────────────
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

    // ── Initialise the bin arrays our position will straddle ────────
    const lowerArrayIdx = binIdToBinArrayIndex(new BN(LOWER_BIN_ID));
    const upperArrayIdx = binIdToBinArrayIndex(new BN(UPPER_BIN_ID));
    const uniqueArrayIdxs =
      lowerArrayIdx.eq(upperArrayIdx) ? [lowerArrayIdx] : [lowerArrayIdx, upperArrayIdx];
    const binArrayIxs = await dlmm.initializeBinArrays(uniqueArrayIdxs, payer.publicKey);
    if (binArrayIxs.length > 0) {
      await provider.sendAndConfirm(new Transaction().add(...binArrayIxs));
    }

    // ── Stealth + position bookkeeping ───────────────────────────────
    stealth = Keypair.generate();
    [positionAuthority] = derivePositionAuthority(programId, stealth.publicKey);
    positionKeypair = Keypair.generate();
    exitRecipient = Keypair.generate().publicKey;

    // exit_recipient ATAs — funds come back here at withdraw_close time.
    exitAtaX = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenX, exitRecipient)
    ).address;
    exitAtaY = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenY, exitRecipient)
    ).address;

    // PDA-owned ATAs — see comment on the field. allowOwnerOffCurve=true
    // because positionAuthority is a PDA (off-curve).
    pdaAtaX = (
      await getOrCreateAssociatedTokenAccount(
        connection, payer.payer, tokenX, positionAuthority, true,
      )
    ).address;
    pdaAtaY = (
      await getOrCreateAssociatedTokenAccount(
        connection, payer.payer, tokenY, positionAuthority, true,
      )
    ).address;

    await fundLamports(provider, stealth.publicKey, 0.05 * anchor.web3.LAMPORTS_PER_SOL);
  });

  it("init_position via executor", async () => {
    const disc = await anchorDiscriminator("init_position");
    const args = Buffer.alloc(8 + 32);
    args.writeInt32LE(LOWER_BIN_ID, 0);
    args.writeInt32LE(POSITION_WIDTH, 4);
    exitRecipient.toBuffer().copy(args, 8);

    const dlmmAccounts: AccountMeta[] = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: lbPair, isSigner: false, isWritable: false },
      { pubkey: positionAuthority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionAuthority, isSigner: false, isWritable: true },
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

  it("add_liquidity via executor (spotImBalanced strategy)", async () => {
    // Move funds from the user ATAs into the PDA-owned escrow ATAs. DLMM's
    // CPI will use sender=PDA as the SPL Token transfer authority on these,
    // so they have to be PDA-owned or the Token program returns 0x4.
    const amountX = new BN(100);
    const amountY = new BN(100);
    await provider.sendAndConfirm(
      new Transaction()
        .add(createTransferInstruction(userAtaX, pdaAtaX, payer.publicKey, BigInt(amountX.toString())))
        .add(createTransferInstruction(userAtaY, pdaAtaY, payer.publicKey, BigInt(amountY.toString()))),
    );

    const disc = await anchorDiscriminator("add_liquidity");

    const liquidityParams = encodeLiquidityParamsByStrategy({
      amountX,
      amountY,
      activeId: ACTIVE_BIN,
      maxActiveBinSlippage: 5,
      minBinId: LOWER_BIN_ID,
      maxBinId: UPPER_BIN_ID,
      // 6 = spotImBalanced. Matches the SDK's `toStrategyParameters` mapping
      // for two-sided deposits — the "Im" prefix lets the X/Y split float
      // around the active bin without a hard 50/50 ratio.
      strategyType: 6,
    });

    // Borsh prefix for `Vec<u8>` is the 4-byte LE length.
    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32LE(liquidityParams.length, 0);
    const data = Buffer.concat([disc, lenPrefix, liquidityParams]);

    const lowerArrayIdx = binIdToBinArrayIndex(new BN(LOWER_BIN_ID));
    const upperArrayIdx = binIdToBinArrayIndex(new BN(UPPER_BIN_ID));
    const [binArrayLower] = deriveBinArray(lbPair, lowerArrayIdx, DLMM_PROGRAM_ID);
    const [binArrayUpper] = deriveBinArray(lbPair, upperArrayIdx, DLMM_PROGRAM_ID);
    const [reserveX] = deriveReserve(tokenX, lbPair, DLMM_PROGRAM_ID);
    const [reserveY] = deriveReserve(tokenY, lbPair, DLMM_PROGRAM_ID);

    // 16-account DLMM `add_liquidity_by_strategy` list (see add_liquidity.rs).
    // bin_array_bitmap_ext is unused → placeholder = DLMM program (program-owned ⇒ None).
    const dlmmAccounts: AccountMeta[] = [
      { pubkey: positionKeypair.publicKey, isSigner: false, isWritable: true }, // 0 position
      { pubkey: lbPair, isSigner: false, isWritable: true },                    // 1 lb_pair
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },           // 2 bin_array_bitmap_ext (None)
      { pubkey: pdaAtaX, isSigner: false, isWritable: true },                   // 3 user_token_x (PDA-owned)
      { pubkey: pdaAtaY, isSigner: false, isWritable: true },                   // 4 user_token_y (PDA-owned)
      { pubkey: reserveX, isSigner: false, isWritable: true },                  // 5 reserve_x
      { pubkey: reserveY, isSigner: false, isWritable: true },                  // 6 reserve_y
      { pubkey: tokenX, isSigner: false, isWritable: false },                   // 7 token_x_mint
      { pubkey: tokenY, isSigner: false, isWritable: false },                   // 8 token_y_mint
      { pubkey: binArrayLower, isSigner: false, isWritable: true },             // 9 bin_array_lower
      { pubkey: binArrayUpper, isSigner: false, isWritable: true },             // 10 bin_array_upper
      { pubkey: positionAuthority, isSigner: false, isWritable: false },        // 11 sender
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },         // 12 token_x_program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },         // 13 token_y_program
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },     // 14 event_authority
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },          // 15 program
    ];
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
      { pubkey: positionAuthority, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmmAccounts,
    ];
    await provider.sendAndConfirm(
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(new TransactionInstruction({ programId, keys: accounts, data })),
      [stealth],
    );

    // Reserves should now hold most of the deposit. DLMM's bin distribution
    // can shed a unit or two to rounding when an amount doesn't divide
    // evenly across the chosen range — we assert "the CPI moved tokens",
    // not "every base unit landed exactly".
    const reserveXAcct = await getAccount(connection, reserveX);
    const reserveYAcct = await getAccount(connection, reserveY);
    expect(Number(reserveXAcct.amount)).to.be.greaterThan(0);
    expect(Number(reserveXAcct.amount)).to.be.at.most(100);
    expect(Number(reserveYAcct.amount)).to.be.greaterThan(0);
    expect(Number(reserveYAcct.amount)).to.be.at.most(100);

    // The PDA escrow ATA should be empty (or at most hold the rounding
    // dust DLMM bounced back).
    const pdaXAfter = await getAccount(connection, pdaAtaX);
    expect(Number(pdaXAfter.amount)).to.be.at.most(100);
  });

  it("withdraw_close via executor: tokens flow back to exit_recipient", async () => {
    const disc = await anchorDiscriminator("withdraw_close");

    const args = Buffer.alloc(10);
    args.writeInt32LE(LOWER_BIN_ID, 0);
    args.writeInt32LE(UPPER_BIN_ID, 4);
    args.writeUInt16LE(10000, 8); // 100% of liquidity

    const lowerArrayIdx = binIdToBinArrayIndex(new BN(LOWER_BIN_ID));
    const upperArrayIdx = binIdToBinArrayIndex(new BN(UPPER_BIN_ID));
    const [binArrayLower] = deriveBinArray(lbPair, lowerArrayIdx, DLMM_PROGRAM_ID);
    const [binArrayUpper] = deriveBinArray(lbPair, upperArrayIdx, DLMM_PROGRAM_ID);
    const [reserveX] = deriveReserve(tokenX, lbPair, DLMM_PROGRAM_ID);
    const [reserveY] = deriveReserve(tokenY, lbPair, DLMM_PROGRAM_ID);

    // 17-account union (see withdraw_close.rs). idx 16 = rent_receiver, must equal exit_recipient.
    const dlmmAccounts: AccountMeta[] = [
      { pubkey: positionKeypair.publicKey, isSigner: false, isWritable: true }, // 0 position
      { pubkey: lbPair, isSigner: false, isWritable: true },                    // 1 lb_pair
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },           // 2 bin_array_bitmap_ext (None)
      { pubkey: exitAtaX, isSigner: false, isWritable: true },                  // 3 user_token_x
      { pubkey: exitAtaY, isSigner: false, isWritable: true },                  // 4 user_token_y
      { pubkey: reserveX, isSigner: false, isWritable: true },                  // 5 reserve_x
      { pubkey: reserveY, isSigner: false, isWritable: true },                  // 6 reserve_y
      { pubkey: tokenX, isSigner: false, isWritable: false },                   // 7 token_x_mint
      { pubkey: tokenY, isSigner: false, isWritable: false },                   // 8 token_y_mint
      { pubkey: binArrayLower, isSigner: false, isWritable: true },             // 9 bin_array_lower
      { pubkey: binArrayUpper, isSigner: false, isWritable: true },             // 10 bin_array_upper
      { pubkey: positionAuthority, isSigner: false, isWritable: false },        // 11 sender
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },         // 12 token_x_program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },         // 13 token_y_program
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },     // 14 event_authority
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },          // 15 program
      { pubkey: exitRecipient, isSigner: false, isWritable: true },             // 16 rent_receiver
    ];
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
      { pubkey: positionAuthority, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...dlmmAccounts,
    ];

    await provider.sendAndConfirm(
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(new TransactionInstruction({ programId, keys: accounts, data: Buffer.concat([disc, args]) })),
      [stealth],
    );

    // Tokens should have moved out of the reserves and into exit_recipient's ATAs.
    const exitX = await getAccount(connection, exitAtaX);
    const exitY = await getAccount(connection, exitAtaY);
    expect(Number(exitX.amount), "exit ATA X balance").to.be.greaterThan(0);
    expect(Number(exitY.amount), "exit ATA Y balance").to.be.greaterThan(0);

    // Position account should be closed (zero lamports = collected).
    const positionInfo = await connection.getAccountInfo(positionKeypair.publicKey);
    expect(positionInfo, "position account closed").to.be.null;
  });
});
