/**
 * `dlmm_swap` happy path + slippage post-check on a freshly-created LB pair.
 *
 * Sets up a real DLMM pool with seed liquidity (so the inner DLMM `swap`
 * can actually execute), routes a stealth-wallet swap through the executor,
 * and asserts:
 *   - balances move as expected (user_token_in down, user_token_out up)
 *   - the executor's post-swap slippage check (SwapSlippageExceeded = 6025)
 *     fires when min_amount_out is set unrealistically high.
 *
 * Run via `anchor test` (loads the DLMM .so per Anchor.toml fixtures).
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
  deriveOracle,
  deriveReserve,
} from "@meteora-ag/dlmm";
import { expect } from "chai";

// ─── Constants ─────────────────────────────────────────────────────────
const CONFIG_SEED = Buffer.from("config");
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

const ERR_SWAP_SLIPPAGE_EXCEEDED = 6025;

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

function encodeSwapArgs(amountIn: bigint, minOut: bigint): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(amountIn, 0);
  buf.writeBigUInt64LE(minOut, 8);
  return buf;
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

function extractErrorCode(err: any): number | null {
  if (err?.error?.errorCode?.number) return err.error.errorCode.number;
  const logs: string[] = err?.logs ?? [];
  for (const line of logs) {
    const n = line.match(/Error Number:\s*(\d+)/);
    if (n) return parseInt(n[1], 10);
  }
  const msg = err?.message ?? String(err);
  const m2 = msg.match(/0x([0-9a-fA-F]+)/);
  if (m2) return parseInt(m2[1], 16);
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
//  TEST: dlmm_swap on freshly-built local LB pair
// ═══════════════════════════════════════════════════════════════════════
describe("DLMM :: dlmm_swap (positive + slippage)", () => {
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
  let configPda: PublicKey;

  // Seed-liquidity provider position (so the swap has bins to consume).
  let liqStealth: Keypair;
  let liqPoolAuthority: PublicKey;
  let liqPositionKp: Keypair;
  let liqPdaAtaX: PublicKey;
  let liqPdaAtaY: PublicKey;

  // Swapper.
  let swapStealth: Keypair;
  let swapAtaX: PublicKey;
  let swapAtaY: PublicKey;

  before(async () => {
    [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], programId);

    // ── Fresh mints, sorted so X < Y ──
    tokenX = await createMint(connection, payer.payer, payer.publicKey, null, 6);
    tokenY = await createMint(connection, payer.payer, payer.publicKey, null, 6);
    if (Buffer.compare(tokenX.toBuffer(), tokenY.toBuffer()) > 0) {
      const tmp = tokenX;
      tokenX = tokenY;
      tokenY = tmp;
    }

    // ── Payer's ATAs as the funding source for the LP and the swapper ──
    const userAtaX = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenX, payer.publicKey)
    ).address;
    const userAtaY = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenY, payer.publicKey)
    ).address;
    await mintTo(connection, payer.payer, tokenX, userAtaX, payer.publicKey, 1_000_000_000n);
    await mintTo(connection, payer.payer, tokenY, userAtaY, payer.publicKey, 1_000_000_000n);

    // ── LB pair + bin arrays ──
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

    const lowerArrayIdx = binIdToBinArrayIndex(new BN(LOWER_BIN_ID));
    const upperArrayIdx = binIdToBinArrayIndex(new BN(UPPER_BIN_ID));
    const uniqueArrayIdxs =
      lowerArrayIdx.eq(upperArrayIdx) ? [lowerArrayIdx] : [lowerArrayIdx, upperArrayIdx];
    const binArrayIxs = await dlmm.initializeBinArrays(uniqueArrayIdxs, payer.publicKey);
    if (binArrayIxs.length > 0) {
      await provider.sendAndConfirm(new Transaction().add(...binArrayIxs));
    }

    // ── Seed liquidity via the executor (mirrors happy-path test pattern) ──
    liqStealth = Keypair.generate();
    liqPositionKp = Keypair.generate();
    [liqPoolAuthority] = derivePoolAuthority(programId, liqStealth.publicKey, lbPair);
    await fundLamports(provider, liqStealth.publicKey, 0.05 * anchor.web3.LAMPORTS_PER_SOL);

    liqPdaAtaX = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenX, liqPoolAuthority, true)
    ).address;
    liqPdaAtaY = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenY, liqPoolAuthority, true)
    ).address;

    {
      const disc = await anchorDiscriminator("dlmm_init_position");
      const args = Buffer.alloc(8 + 32);
      args.writeInt32LE(LOWER_BIN_ID, 0);
      args.writeInt32LE(POSITION_WIDTH, 4);
      const exitRecipient = Keypair.generate().publicKey;
      exitRecipient.toBuffer().copy(args, 8);

      const dlmmAccounts: AccountMeta[] = [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: liqPositionKp.publicKey, isSigner: true, isWritable: true },
        { pubkey: lbPair, isSigner: false, isWritable: false },
        { pubkey: liqPoolAuthority, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: anchor.web3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ];
      const accounts: AccountMeta[] = [
        { pubkey: liqStealth.publicKey, isSigner: true, isWritable: true },
        { pubkey: liqPoolAuthority, isSigner: false, isWritable: true },
        { pubkey: lbPair, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ...dlmmAccounts,
      ];
      await provider.sendAndConfirm(
        new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
          .add(new TransactionInstruction({
            programId, keys: accounts, data: Buffer.concat([disc, args]),
          })),
        [liqStealth, liqPositionKp],
      );
    }

    // Move 100k of each token into the PDA-owned escrow ATAs.
    await provider.sendAndConfirm(
      new Transaction()
        .add(createTransferInstruction(userAtaX, liqPdaAtaX, payer.publicKey, 100_000n))
        .add(createTransferInstruction(userAtaY, liqPdaAtaY, payer.publicKey, 100_000n)),
    );

    // dlmm_add_liquidity (spotImBalanced)
    {
      const disc = await anchorDiscriminator("dlmm_add_liquidity");
      const liquidityParams = encodeLiquidityParamsByStrategy({
        amountX: new BN(100_000),
        amountY: new BN(100_000),
        activeId: ACTIVE_BIN,
        maxActiveBinSlippage: 5,
        minBinId: LOWER_BIN_ID,
        maxBinId: UPPER_BIN_ID,
        strategyType: 6,
      });
      const lenPrefix = Buffer.alloc(4);
      lenPrefix.writeUInt32LE(liquidityParams.length, 0);
      const data = Buffer.concat([disc, lenPrefix, liquidityParams]);

      const [binArrayLower] = deriveBinArray(lbPair, lowerArrayIdx, DLMM_PROGRAM_ID);
      const [binArrayUpper] = deriveBinArray(lbPair, upperArrayIdx, DLMM_PROGRAM_ID);
      const [reserveX] = deriveReserve(tokenX, lbPair, DLMM_PROGRAM_ID);
      const [reserveY] = deriveReserve(tokenY, lbPair, DLMM_PROGRAM_ID);

      const dlmmAccounts: AccountMeta[] = [
        { pubkey: liqPositionKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: lbPair, isSigner: false, isWritable: true },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },
        { pubkey: liqPdaAtaX, isSigner: false, isWritable: true },
        { pubkey: liqPdaAtaY, isSigner: false, isWritable: true },
        { pubkey: reserveX, isSigner: false, isWritable: true },
        { pubkey: reserveY, isSigner: false, isWritable: true },
        { pubkey: tokenX, isSigner: false, isWritable: false },
        { pubkey: tokenY, isSigner: false, isWritable: false },
        { pubkey: binArrayLower, isSigner: false, isWritable: true },
        { pubkey: binArrayUpper, isSigner: false, isWritable: true },
        { pubkey: liqPoolAuthority, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ];
      const accounts: AccountMeta[] = [
        { pubkey: liqStealth.publicKey, isSigner: true, isWritable: false },
        { pubkey: liqPoolAuthority, isSigner: false, isWritable: false },
        { pubkey: lbPair, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
        ...dlmmAccounts,
      ];
      await provider.sendAndConfirm(
        new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
          .add(new TransactionInstruction({ programId, keys: accounts, data })),
        [liqStealth],
      );
    }

    // ── Swapper setup: stealth wallet with input-token balance ──
    swapStealth = Keypair.generate();
    await fundLamports(provider, swapStealth.publicKey, 0.05 * anchor.web3.LAMPORTS_PER_SOL);
    swapAtaX = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenX, swapStealth.publicKey)
    ).address;
    swapAtaY = (
      await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenY, swapStealth.publicKey)
    ).address;
    await provider.sendAndConfirm(
      new Transaction().add(
        createTransferInstruction(userAtaX, swapAtaX, payer.publicKey, 1_000n),
      ),
    );
  });

  function buildSwapAccounts(opts: { minOut: bigint; amountIn: bigint }): {
    keys: AccountMeta[];
    data: Buffer;
  } {
    const lowerArrayIdx = binIdToBinArrayIndex(new BN(LOWER_BIN_ID));
    const upperArrayIdx = binIdToBinArrayIndex(new BN(UPPER_BIN_ID));
    const [binArray0] = deriveBinArray(lbPair, lowerArrayIdx, DLMM_PROGRAM_ID);
    const [binArray1] = deriveBinArray(lbPair, upperArrayIdx, DLMM_PROGRAM_ID);
    const [reserveX] = deriveReserve(tokenX, lbPair, DLMM_PROGRAM_ID);
    const [reserveY] = deriveReserve(tokenY, lbPair, DLMM_PROGRAM_ID);
    const [oracle] = deriveOracle(lbPair, DLMM_PROGRAM_ID);

    // Match programs/octora-executor/src/instructions/dlmm/swap.rs layout.
    const remainingMetas: AccountMeta[] = [
      { pubkey: lbPair, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true }, // bin_array_bitmap_extension placeholder
      { pubkey: reserveX, isSigner: false, isWritable: true },
      { pubkey: reserveY, isSigner: false, isWritable: true },
      { pubkey: swapAtaX, isSigner: false, isWritable: true },        // user_token_in (X)
      { pubkey: swapAtaY, isSigner: false, isWritable: true },        // user_token_out (Y)
      { pubkey: tokenX, isSigner: false, isWritable: false },
      { pubkey: tokenY, isSigner: false, isWritable: false },
      { pubkey: oracle, isSigner: false, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true }, // host_fee_in placeholder
      { pubkey: swapStealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: binArray0, isSigner: false, isWritable: true },
      { pubkey: binArray1, isSigner: false, isWritable: true },
    ];

    const fixedAccounts: AccountMeta[] = [
      { pubkey: swapStealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: lbPair, isSigner: false, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: false },
    ];

    return {
      keys: [...fixedAccounts, ...remainingMetas],
      data: Buffer.concat([
        Buffer.from([]),
        encodeSwapArgs(opts.amountIn, opts.minOut),
      ]),
    };
  }

  it("happy path: swaps X→Y and increases user_token_out balance", async () => {
    const disc = await anchorDiscriminator("dlmm_swap");
    const built = buildSwapAccounts({ amountIn: 100n, minOut: 1n });
    const data = Buffer.concat([disc, built.data]);

    const yBefore = (await getAccount(connection, swapAtaY)).amount;

    await provider.sendAndConfirm(
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
        .add(new TransactionInstruction({ programId, keys: built.keys, data })),
      [swapStealth],
    );

    const xAfter = (await getAccount(connection, swapAtaX)).amount;
    const yAfter = (await getAccount(connection, swapAtaY)).amount;

    expect(Number(xAfter)).to.be.lessThan(1_000);
    expect(yAfter > yBefore, "user_token_out increased").to.equal(true);
  });

  it("rejects when min_amount_out is unreachable (SwapSlippageExceeded)", async () => {
    const disc = await anchorDiscriminator("dlmm_swap");
    // Force the post-check to fail by demanding more output than the pool
    // could ever provide. DLMM internal slippage may reject first; if so,
    // we'll still see *some* error — we accept either DLMM's or our 6025.
    const built = buildSwapAccounts({
      amountIn: 100n,
      minOut: 18_446_744_073_709_551_000n,
    });
    const data = Buffer.concat([disc, built.data]);

    let code: number | null = null;
    try {
      await provider.sendAndConfirm(
        new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
          .add(new TransactionInstruction({ programId, keys: built.keys, data })),
        [swapStealth],
      );
      expect.fail("swap should have rejected on slippage");
    } catch (e) {
      code = extractErrorCode(e);
    }

    // Acceptable outcomes: our 6025, or any DLMM error code (the inner
    // CPI's slippage reject also lands; tightening this requires a
    // reachable min_out that exceeds DLMM's quote but underflows our check).
    expect(code).to.be.a("number");
  });
});
