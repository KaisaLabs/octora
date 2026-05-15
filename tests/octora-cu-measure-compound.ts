/**
 * CU + tx-size measurement harness for ticket
 * `.scratch/dust-and-stuck-funds/issues/01-cu-prototype-atomic-deposit-add-lp.md`.
 *
 * Angle 2 of the ticket's "Reopen — 2026-05-15" rescope:
 *   measure the existing two-tx baseline (mixer.deposit + dlmm.add_liquidity)
 *   as an *upper bound* on what an atomic single-tx compound would consume.
 *
 * Angle 1 floor: also measure the fail-closed `compound_withdraw_add_liquidity`
 *   so we have an instrumented lower bound from the existing scaffold.
 *
 * Three pool shapes are exercised to satisfy the rescoped acceptance criterion
 * "tight-range / wide-range / cold bin arrays":
 *   - TIGHT   : POSITION_WIDTH = 20  (single bin-array)
 *   - WIDE    : POSITION_WIDTH = 70  (two distinct bin-arrays)
 *   - COLD    : same width as WIDE but on a *separate* LB pair whose bin
 *               arrays have never been written to (one extra init tx is
 *               folded into the add_liquidity measurement).
 *
 * Output: one markdown table per scenario printed to stdout. The harness
 * captures both `meta.computeUnitsConsumed` from `getTransaction` and the
 * serialized transaction byte length (which is what counts against the
 * 1232-byte Solana packet limit).
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import DLMM, {
  binIdToBinArrayIndex,
  deriveBinArray,
  deriveReserve,
  deriveLbPairWithPresetParamWithIndexKey,
} from "@meteora-ag/dlmm";
import { buildPoseidon } from "circomlibjs";
import { randomBytes, createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";

// ─── Constants ─────────────────────────────────────────────────────────

const POOL_AUTHORITY_SEED = Buffer.from("pool-authority");
const MIXER_POOL_SEED = Buffer.from("mixer_pool");
const COMMITMENT_SEED = Buffer.from("commitment");
const TREE_LEVELS = 20;
const DENOMINATION = new anchor.BN(10_000_000); // 0.01 SOL

const DLMM_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
);
const DLMM_EVENT_AUTHORITY = new PublicKey(
  "D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6",
);
// PresetParameter v2 on mainnet (binStep=200, baseFactor=10000). Surfpool
// proxies the read from mainnet so the account materialises in the local
// surfnet on first access. The previously-used BYQtcD... v1 preset has been
// closed on mainnet (returns null) — see ADR-0004.
const PRESET_PARAMETER = new PublicKey(
  "335un4FX5baZ17bvmfNFR8YM4C7zaLkATNHvSaizUqyZ",
);
const ACTIVE_BIN = 0;

// ─── Helpers ───────────────────────────────────────────────────────────

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

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

function deriveMixerPoolPDA(
  programId: PublicKey,
  denomination: anchor.BN,
): [PublicKey, number] {
  const denomBuf = denomination.toArrayLike(Buffer, "le", 8);
  return PublicKey.findProgramAddressSync(
    [MIXER_POOL_SEED, denomBuf],
    programId,
  );
}

function deriveCommitmentPDA(
  programId: PublicKey,
  pool: PublicKey,
  commitment: Buffer,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [COMMITMENT_SEED, pool.toBuffer(), commitment],
    programId,
  );
}

function bigintToBytes32(value: bigint): Buffer {
  const hex = value.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

let poseidonImpl: any;
async function initPoseidon() {
  if (!poseidonImpl) poseidonImpl = await buildPoseidon();
  return poseidonImpl;
}
function poseidonHash(inputs: bigint[]): bigint {
  const p = poseidonImpl;
  return BigInt(p.F.toString(p(inputs.map((x: bigint) => p.F.e(x)))));
}
function randomFieldElement(): bigint {
  return BigInt("0x" + randomBytes(31).toString("hex"));
}
function generateCommitment() {
  const secret = randomFieldElement();
  const nullifier = randomFieldElement();
  return poseidonHash([secret, nullifier]);
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

// ─── Measurement ───────────────────────────────────────────────────────

type Sample = {
  label: string;
  cu: number | null;
  txBytes: number;
  notes: string;
};

const samples: Sample[] = [];

async function measureAndSend(
  provider: anchor.AnchorProvider,
  label: string,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  notes: string = "",
): Promise<string> {
  const tx = new Transaction();
  for (const ix of ixs) tx.add(ix);
  // AnchorProvider.sendAndConfirm handles feePayer + recentBlockhash + wallet
  // signature + any extra signers. We then read the confirmed tx back to
  // grab `meta.computeUnitsConsumed` and the serialized byte length.
  const sig = await provider.sendAndConfirm(tx, signers);
  // Re-serialize for size measurement. sendAndConfirm mutates the tx in place
  // with the wallet signature; partialSign of additional signers was already
  // applied by provider, so the serialized blob here matches what hit the wire.
  const serialized = tx.serialize({ verifySignatures: false });
  const txInfo = await provider.connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const cu = txInfo?.meta?.computeUnitsConsumed ?? null;
  samples.push({ label, cu: cu == null ? null : Number(cu), txBytes: serialized.length, notes });
  return sig;
}

// ─── Setup ─────────────────────────────────────────────────────────────

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const payer = provider.wallet as anchor.Wallet;
const connection = provider.connection;

const mixerProgram = anchor.workspace.octoraMixer as Program;
const executorProgram = anchor.workspace.octoraExecutor as Program;
const MIXER_PROGRAM_ID = mixerProgram.programId;
const EXECUTOR_PROGRAM_ID = executorProgram.programId;

async function ensureMixerInitialized(): Promise<PublicKey> {
  const [pool] = deriveMixerPoolPDA(MIXER_PROGRAM_ID, DENOMINATION);
  const info = await connection.getAccountInfo(pool);
  if (info) return pool;

  const adminPath = `${homedir()}/.config/solana/octora-mixer-admin.json`;
  if (!existsSync(adminPath)) {
    throw new Error(
      `mixer ADMIN_AUTHORITY keypair not found at ${adminPath} — needed to call initialize`,
    );
  }
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(adminPath, "utf8"))),
  );
  // Fund the admin if it has no lamports on this surfnet.
  const bal = await connection.getBalance(admin.publicKey);
  if (bal < 1_000_000_000) {
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: admin.publicKey,
          lamports: 1_000_000_000,
        }),
      ),
    );
  }
  await mixerProgram.methods
    .initialize(DENOMINATION)
    .accounts({
      authority: admin.publicKey,
      mixerPool: pool,
      systemProgram: SystemProgram.programId,
    })
    .signers([admin])
    .rpc();
  return pool;
}

async function ensureExecutorInitialized(): Promise<void> {
  const CONFIG_SEED = Buffer.from("config");
  const [cfg] = PublicKey.findProgramAddressSync([CONFIG_SEED], EXECUTOR_PROGRAM_ID);
  const info = await connection.getAccountInfo(cfg);
  if (info) return;
  // Anchor IDL exposes initialize as `init_executor` / `initialize` etc.
  // Find it.
  const idl: any = (executorProgram as any).idl;
  const initIx = idl.instructions.find((i: any) =>
    /^init/.test(i.name),
  );
  if (!initIx) throw new Error("no executor init ix in IDL");
  await executorProgram.methods[
    initIx.name.replace(/_([a-z])/g, (_: any, c: string) => c.toUpperCase())
  ]()
    .accounts({
      authority: payer.publicKey,
      config: cfg,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

async function createFreshPair(): Promise<{
  lbPair: PublicKey;
  tokenX: PublicKey;
  tokenY: PublicKey;
}> {
  let tokenX = await createMint(connection, payer.payer, payer.publicKey, null, 6);
  let tokenY = await createMint(connection, payer.payer, payer.publicKey, null, 6);
  if (Buffer.compare(tokenX.toBuffer(), tokenY.toBuffer()) > 0) {
    [tokenX, tokenY] = [tokenY, tokenX];
  }
  const userAtaX = (
    await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenX, payer.publicKey)
  ).address;
  const userAtaY = (
    await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenY, payer.publicKey)
  ).address;
  await mintTo(connection, payer.payer, tokenX, userAtaX, payer.publicKey, 1_000_000_000n);
  await mintTo(connection, payer.payer, tokenY, userAtaY, payer.publicKey, 1_000_000_000n);

  const createPairTx = await DLMM.createLbPair2(
    connection,
    payer.publicKey,
    tokenX,
    tokenY,
    PRESET_PARAMETER,
    new BN(ACTIVE_BIN),
  );
  await provider.sendAndConfirm(createPairTx);
  // createLbPair2 derives the lb_pair from the preset PDA + token mints.
  // Reverse the SDK derivation: same seed structure as the SDK.
  const [lbPair] = deriveLbPairWithPresetParamWithIndexKey(
    PRESET_PARAMETER,
    tokenX,
    tokenY,
    DLMM_PROGRAM_ID,
  );
  return { lbPair, tokenX, tokenY };
}

async function measureMixerDeposit(label: string): Promise<void> {
  const pool = await ensureMixerInitialized();
  const commitment = generateCommitment();
  const commitmentBytes = bigintToBytes32(commitment);
  const [commitmentPDA] = deriveCommitmentPDA(MIXER_PROGRAM_ID, pool, commitmentBytes);

  const ix = await mixerProgram.methods
    .deposit(Array.from(commitmentBytes))
    .accounts({
      depositor: payer.publicKey,
      mixerPool: pool,
      commitmentAccount: commitmentPDA,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  await measureAndSend(
    provider,
    label,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix],
    [],
    "incremental Merkle update over 20 levels",
  );
}

async function measureDlmmInitAndAdd(opts: {
  label: string;
  positionWidth: number;
  lowerBinId: number;
  coldBinArrays: boolean;
}): Promise<void> {
  const { lbPair, tokenX, tokenY } = await createFreshPair();
  const dlmm = await DLMM.create(connection, lbPair);
  const CONFIG_SEED = Buffer.from("config");
  const [executorConfigPda] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    EXECUTOR_PROGRAM_ID,
  );

  const lowerBinId = opts.lowerBinId;
  const upperBinId = opts.lowerBinId + opts.positionWidth - 1;
  const lowerArrayIdx = binIdToBinArrayIndex(new BN(lowerBinId));
  const upperArrayIdx = binIdToBinArrayIndex(new BN(upperBinId));
  const uniqueArrayIdxs = lowerArrayIdx.eq(upperArrayIdx)
    ? [lowerArrayIdx]
    : [lowerArrayIdx, upperArrayIdx];

  const binArrayIxs = await dlmm.initializeBinArrays(uniqueArrayIdxs, payer.publicKey);
  let initBinArraysTxBytes = 0;
  let initBinArraysCu: number | null = null;
  if (!opts.coldBinArrays && binArrayIxs.length > 0) {
    // Initialise *outside* the measured tx (precondition).
    await provider.sendAndConfirm(new Transaction().add(...binArrayIxs));
  } else if (opts.coldBinArrays && binArrayIxs.length > 0) {
    // Measure bin-array init as its own preparatory tx.
    const sig = await measureAndSend(
      provider,
      `${opts.label}: dlmm.initializeBinArrays`,
      binArrayIxs,
      [],
      `${uniqueArrayIdxs.length} bin-array(s)`,
    );
    const last = samples[samples.length - 1];
    initBinArraysCu = last.cu;
    initBinArraysTxBytes = last.txBytes;
  }

  // Stealth + position + PDA ATAs
  const stealth = Keypair.generate();
  const positionKeypair = Keypair.generate();
  const [poolAuthority] = derivePoolAuthority(EXECUTOR_PROGRAM_ID, stealth.publicKey, lbPair);

  const pdaAtaX = (
    await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenX, poolAuthority, true)
  ).address;
  const pdaAtaY = (
    await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenY, poolAuthority, true)
  ).address;

  // Fund stealth + PDA ATAs.
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: stealth.publicKey,
        lamports: 0.05 * anchor.web3.LAMPORTS_PER_SOL,
      }),
    ),
  );
  const userAtaX = (
    await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenX, payer.publicKey)
  ).address;
  const userAtaY = (
    await getOrCreateAssociatedTokenAccount(connection, payer.payer, tokenY, payer.publicKey)
  ).address;
  await provider.sendAndConfirm(
    new Transaction()
      .add(createTransferInstruction(userAtaX, pdaAtaX, payer.publicKey, 1_000n))
      .add(createTransferInstruction(userAtaY, pdaAtaY, payer.publicKey, 1_000n)),
  );

  // ── init_position via executor ──
  {
    const disc = anchorDiscriminator("dlmm_init_position");
    const args = Buffer.alloc(8 + 32);
    args.writeInt32LE(lowerBinId, 0);
    args.writeInt32LE(opts.positionWidth, 4);
    Keypair.generate().publicKey.toBuffer().copy(args, 8); // exit_recipient placeholder

    const dlmmAccounts: AccountMeta[] = [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: positionKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: lbPair, isSigner: false, isWritable: false },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolAuthority, isSigner: false, isWritable: true },
      { pubkey: lbPair, isSigner: false, isWritable: false },
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: executorConfigPda, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...dlmmAccounts,
    ];
    await measureAndSend(
      provider,
      `${opts.label}: dlmm_init_position`,
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        new TransactionInstruction({
          programId: EXECUTOR_PROGRAM_ID,
          keys: accounts,
          data: Buffer.concat([disc, args]),
        }),
      ],
      [stealth, positionKeypair],
      `width=${opts.positionWidth}`,
    );
  }

  // ── add_liquidity via executor ──
  {
    const amountX = new BN(100);
    const amountY = new BN(100);
    const disc = anchorDiscriminator("dlmm_add_liquidity");
    const liquidityParams = encodeLiquidityParamsByStrategy({
      amountX,
      amountY,
      activeId: ACTIVE_BIN,
      maxActiveBinSlippage: 5,
      minBinId: lowerBinId,
      maxBinId: upperBinId,
      strategyType: 6,
    });
    // AddLiquidityByStrategy2 args = LiquidityParameterByStrategy (97 bytes)
    //  + RemainingAccountsInfo (1 empty vec = 4 zero bytes).
    const remainingInfoEmpty = Buffer.alloc(4); // u32 LE = 0 slices
    const fullParams = Buffer.concat([liquidityParams, remainingInfoEmpty]);
    const lenPrefix = Buffer.alloc(4);
    lenPrefix.writeUInt32LE(fullParams.length, 0);
    const data = Buffer.concat([disc, lenPrefix, fullParams]);

    const [binArrayLower] = deriveBinArray(lbPair, lowerArrayIdx, DLMM_PROGRAM_ID);
    const [binArrayUpper] = deriveBinArray(lbPair, upperArrayIdx, DLMM_PROGRAM_ID);
    const [reserveX] = deriveReserve(tokenX, lbPair, DLMM_PROGRAM_ID);
    const [reserveY] = deriveReserve(tokenY, lbPair, DLMM_PROGRAM_ID);

    // Executor v2 layout (see programs/octora-executor/src/instructions/dlmm/add_liquidity.rs):
    //   fixed slots 0..13, then bin_array_lower, bin_array_upper at the tail.
    const dlmmAccounts: AccountMeta[] = [
      { pubkey: positionKeypair.publicKey, isSigner: false, isWritable: true }, // 0 position
      { pubkey: lbPair, isSigner: false, isWritable: true },                    // 1 lb_pair
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },           // 2 bin_array_bitmap_ext sentinel
      { pubkey: pdaAtaX, isSigner: false, isWritable: true },                   // 3 user_token_x
      { pubkey: pdaAtaY, isSigner: false, isWritable: true },                   // 4 user_token_y
      { pubkey: reserveX, isSigner: false, isWritable: true },                  // 5 reserve_x
      { pubkey: reserveY, isSigner: false, isWritable: true },                  // 6 reserve_y
      { pubkey: tokenX, isSigner: false, isWritable: false },                   // 7 token_x_mint
      { pubkey: tokenY, isSigner: false, isWritable: false },                   // 8 token_y_mint
      { pubkey: poolAuthority, isSigner: false, isWritable: false },            // 9 sender (re-pinned)
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },         // 10 token_x_program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },         // 11 token_y_program
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },     // 12 event_authority
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },          // 13 program
      { pubkey: binArrayLower, isSigner: false, isWritable: true },             // tail: bin_array_lower
      { pubkey: binArrayUpper, isSigner: false, isWritable: true },             // tail: bin_array_upper
    ];
    const accounts: AccountMeta[] = [
      { pubkey: stealth.publicKey, isSigner: true, isWritable: false },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      // IDL order: pool_authority, dlmm_program, lb_pair, config
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: lbPair, isSigner: false, isWritable: false },
      { pubkey: executorConfigPda, isSigner: false, isWritable: false },
      ...dlmmAccounts,
    ];
    await measureAndSend(
      provider,
      `${opts.label}: dlmm_add_liquidity`,
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        new TransactionInstruction({
          programId: EXECUTOR_PROGRAM_ID,
          keys: accounts,
          data,
        }),
      ],
      [stealth],
      `bin range ${lowerBinId}..${upperBinId}${
        opts.coldBinArrays ? " (cold bin-arrays measured separately)" : ""
      }`,
    );
  }
}

async function measureCompoundFailClosed(): Promise<void> {
  const CONFIG_SEED = Buffer.from("config");
  const [cfg] = PublicKey.findProgramAddressSync([CONFIG_SEED], EXECUTOR_PROGRAM_ID);
  const stealth = Keypair.generate();
  const disc = anchorDiscriminator("compound_withdraw_add_liquidity");

  // _withdraw_proof_data: [u8; 256], _withdraw_public_inputs: [u8; 160],
  // _liquidity_params: Vec<u8>
  const proof = Buffer.alloc(256);
  const inputs = Buffer.alloc(160);
  const liquidityParams = encodeLiquidityParamsByStrategy({
    amountX: new BN(100),
    amountY: new BN(100),
    activeId: 0,
    maxActiveBinSlippage: 5,
    minBinId: -10,
    maxBinId: 9,
    strategyType: 6,
  });
  const lenPrefix = Buffer.alloc(4);
  lenPrefix.writeUInt32LE(liquidityParams.length, 0);
  const data = Buffer.concat([disc, proof, inputs, lenPrefix, liquidityParams]);

  const accounts: AccountMeta[] = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: stealth.publicKey, isSigner: false, isWritable: false },
    { pubkey: MIXER_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: cfg, isSigner: false, isWritable: false },
  ];

  // Expected to revert with CompoundCpiUnsupported (6xxx). We still get a
  // signature and `meta.computeUnitsConsumed`. Use sendTransaction with
  // skipPreflight=true to make sure the failing tx lands on-chain.
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    new TransactionInstruction({
      programId: EXECUTOR_PROGRAM_ID,
      keys: accounts,
      data,
    }),
  );
  tx.feePayer = payer.publicKey;
  const { blockhash } = await provider.connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  const signed = await payer.signTransaction(tx);
  const raw = signed.serialize({ verifySignatures: false });
  const sig = await connection.sendRawTransaction(raw, { skipPreflight: true });
  try {
    await connection.confirmTransaction(sig, "confirmed");
  } catch {
    // expected fail
  }
  const info = await connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  samples.push({
    label: "compound_withdraw_add_liquidity (fail-closed)",
    cu: info?.meta?.computeUnitsConsumed
      ? Number(info.meta.computeUnitsConsumed)
      : null,
    txBytes: raw.length,
    notes: "executor returns CompoundCpiUnsupported after program-id validation",
  });
}

// ─── Runner ────────────────────────────────────────────────────────────

(async () => {
  await initPoseidon();
  await ensureMixerInitialized();
  try {
    await ensureExecutorInitialized();
  } catch (e: any) {
    console.error("executor init failed (likely already initialised):", e?.message ?? e);
  }

  // Baseline mixer.deposit (only measured once — same cost regardless of pool).
  await measureMixerDeposit("mixer.deposit");

  // Three scenarios for DLMM.
  await measureDlmmInitAndAdd({
    label: "TIGHT",
    positionWidth: 20,
    lowerBinId: -10,
    coldBinArrays: false,
  });
  await measureDlmmInitAndAdd({
    label: "WIDE",
    positionWidth: 70,
    lowerBinId: -35,
    coldBinArrays: false,
  });
  await measureDlmmInitAndAdd({
    label: "COLD",
    positionWidth: 70,
    lowerBinId: -35,
    coldBinArrays: true,
  });

  // Fail-closed atomic-compound floor.
  await measureCompoundFailClosed();

  // ── Report ──
  const rows = samples.map((s) => ({
    Label: s.label,
    CU: s.cu == null ? "n/a" : s.cu.toLocaleString(),
    "tx bytes": s.txBytes.toString(),
    Notes: s.notes,
  }));
  console.log("\n\n=== CU + tx-size measurements (compound atomic baseline) ===\n");
  // Render simple markdown table.
  const header = Object.keys(rows[0]);
  console.log(`| ${header.join(" | ")} |`);
  console.log(`| ${header.map(() => "---").join(" | ")} |`);
  for (const r of rows) {
    console.log(`| ${header.map((h) => (r as any)[h]).join(" | ")} |`);
  }

  // ── Derived totals: per-scenario atomic upper bound (mixer + dlmm.add) ──
  const mixerSample = samples.find((s) => s.label === "mixer.deposit")!;
  const scenarioLabels = ["TIGHT", "WIDE", "COLD"];
  console.log("\n\n=== Upper-bound atomic single-tx compound (mixer.deposit + dlmm_add_liquidity) ===\n");
  console.log("| Pool | CU (sum) | tx bytes (sum) | Notes |");
  console.log("| --- | --- | --- | --- |");
  for (const lab of scenarioLabels) {
    const add = samples.find((s) => s.label === `${lab}: dlmm_add_liquidity`);
    if (!add) continue;
    const sumCu =
      (mixerSample.cu ?? 0) + (add.cu ?? 0);
    const sumBytes = mixerSample.txBytes + add.txBytes;
    console.log(
      `| ${lab} | ${sumCu.toLocaleString()} | ${sumBytes} | ${
        lab === "COLD"
          ? "bin-array init NOT folded in (would need extra ix)"
          : "init_position assumed already paid in a prior tx"
      } |`,
    );
  }
  console.log("\nSolana hard limits: 1_400_000 CU per tx, 1232 bytes per packet.\n");
})().catch((err) => {
  console.error("measurement failed:", err);
  process.exit(1);
});
