/**
 * Executor module — orchestrates DLMM setup and builds unsigned transactions
 * for the integrated test page.
 *
 * This service is intentionally test-flavoured: it creates fresh SPL mints,
 * a fresh DLMM LB pair, and bin arrays on demand, all signed by the API's
 * relayer hot wallet. It then builds (but does not sign) the executor's
 * lifecycle transactions for the browser to sign with the stealth keypair.
 */

import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import type { AccountMeta } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
} from "@solana/spl-token";
import DLMM, {
  binIdToBinArrayIndex,
  deriveBinArray,
  deriveLbPair2,
  deriveReserve,
} from "@meteora-ag/dlmm";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDL_PATH = join(__dirname, "..", "execution", "clients", "idl", "octora_executor.json");

const POSITION_AUTHORITY_SEED = Buffer.from("position-authority");
const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const DLMM_EVENT_AUTHORITY = new PublicKey("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");
// preset_parameter PDA at v2-style seeds with v1 layout — see the
// happy-path test for context. binStep=10, baseFactor=10000.
const PRESET_PARAMETER = new PublicKey("BYQtcDyv2BoFuf5ghsYDGPA8iX5F4WquK7zCzUsDwJ63");
const BIN_STEP = 10;
const BASE_FACTOR = 10000;
const ACTIVE_BIN = 0;

export interface TestPairConfig {
  tokenX: string;
  tokenY: string;
  lbPair: string;
  binArrayLower: string;
  binArrayUpper: string;
  lowerBinId: number;
  upperBinId: number;
  width: number;
  activeBin: number;
  binStep: number;
  baseFactor: number;
}

export interface ExecutorServiceConfig {
  rpcUrl: string;
  /** Hot wallet that pays fees, owns the mint authority for test mints, and acts as DLMM funder. */
  relayerKeypair: Keypair;
  /** Deployed octora-executor program id. */
  executorProgramId: PublicKey;
}

export class ExecutorService {
  private connection: Connection;
  private relayer: Keypair;
  private programId: PublicKey;
  private program: Program;
  private provider: AnchorProvider;

  constructor(config: ExecutorServiceConfig) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.relayer = config.relayerKeypair;
    this.programId = config.executorProgramId;

    const wallet = new Wallet(this.relayer);
    this.provider = new AnchorProvider(this.connection, wallet, { commitment: "confirmed" });
    const idl = JSON.parse(readFileSync(IDL_PATH, "utf-8"));
    this.program = new Program(idl, this.provider);
  }

  /**
   * One-shot test setup: two SPL mints (relayer is mint authority), one DLMM
   * LB pair with `(binStep=10, baseFactor=10000, activeBin=0)`, and the two
   * bin arrays our default `[-10..9]` position straddles.
   *
   * Idempotent on a single API process: a second call creates a *new* pair —
   * the browser is the source of truth on which one is "current".
   */
  async setupTestPair(opts: {
    lowerBinId?: number;
    width?: number;
  } = {}): Promise<TestPairConfig> {
    const lowerBinId = opts.lowerBinId ?? -10;
    const width = opts.width ?? 20;
    const upperBinId = lowerBinId + width - 1;

    // ── Mints ────────────────────────────────────────────────────────
    let tokenX = await createMint(this.connection, this.relayer, this.relayer.publicKey, null, 6);
    let tokenY = await createMint(this.connection, this.relayer, this.relayer.publicKey, null, 6);
    // DLMM derives the LB pair PDA from the smaller-pubkey-first ordering of
    // the two mints. Match it locally so `deriveLbPair2` produces the same
    // address the SDK passes into createLbPair.
    if (Buffer.compare(tokenX.toBuffer(), tokenY.toBuffer()) > 0) {
      [tokenX, tokenY] = [tokenY, tokenX];
    }

    // ── LB pair ──────────────────────────────────────────────────────
    const createPairTx = await DLMM.createLbPair(
      this.connection,
      this.relayer.publicKey,
      tokenX,
      tokenY,
      new BN(BIN_STEP),
      new BN(BASE_FACTOR),
      PRESET_PARAMETER,
      new BN(ACTIVE_BIN),
    );
    await this.provider.sendAndConfirm(createPairTx, [this.relayer]);

    const [lbPair] = deriveLbPair2(
      tokenX,
      tokenY,
      new BN(BIN_STEP),
      new BN(BASE_FACTOR),
      DLMM_PROGRAM_ID,
    );

    const dlmm = await DLMM.create(this.connection, lbPair);

    // ── Bin arrays ───────────────────────────────────────────────────
    const lowerArrayIdx = binIdToBinArrayIndex(new BN(lowerBinId));
    const upperArrayIdx = binIdToBinArrayIndex(new BN(upperBinId));
    const uniqueArrayIdxs =
      lowerArrayIdx.eq(upperArrayIdx) ? [lowerArrayIdx] : [lowerArrayIdx, upperArrayIdx];

    const binArrayIxs = await dlmm.initializeBinArrays(uniqueArrayIdxs, this.relayer.publicKey);
    if (binArrayIxs.length > 0) {
      await this.provider.sendAndConfirm(
        new Transaction().add(...binArrayIxs),
        [this.relayer],
      );
    }

    const [binArrayLower] = deriveBinArray(lbPair, lowerArrayIdx, DLMM_PROGRAM_ID);
    const [binArrayUpper] = deriveBinArray(lbPair, upperArrayIdx, DLMM_PROGRAM_ID);

    return {
      tokenX: tokenX.toBase58(),
      tokenY: tokenY.toBase58(),
      lbPair: lbPair.toBase58(),
      binArrayLower: binArrayLower.toBase58(),
      binArrayUpper: binArrayUpper.toBase58(),
      lowerBinId,
      upperBinId,
      width,
      activeBin: ACTIVE_BIN,
      binStep: BIN_STEP,
      baseFactor: BASE_FACTOR,
    };
  }

  /**
   * Use an EXISTING devnet LB pair (typically discovered via the Meteora
   * devnet API). Reads on-chain state for tokenX/Y, picks a position range
   * around the pool's current `activeId`, and initialises the two bin
   * arrays our position will straddle if they don't already exist.
   *
   * Returns the same `TestPairConfig` shape `setupTestPair` does, so the
   * rest of the flow doesn't have to care which path produced it.
   */
  async useExistingPool(args: {
    lbPair: PublicKey;
    /** Position width in bins. Defaults to 20. */
    width?: number;
  }): Promise<TestPairConfig> {
    const width = args.width ?? 20;
    const dlmm = await DLMM.create(this.connection, args.lbPair);

    const tokenX = dlmm.lbPair.tokenXMint;
    const tokenY = dlmm.lbPair.tokenYMint;
    const activeBin = dlmm.lbPair.activeId;
    const binStep = dlmm.lbPair.binStep;

    // Centre the position on the pool's active bin so both bin arrays we
    // initialise are likely to already exist (a hot pool keeps the
    // active-bin's array warm).
    const lowerBinId = activeBin - Math.floor(width / 2);
    const upperBinId = lowerBinId + width - 1;

    const lowerArrayIdx = binIdToBinArrayIndex(new BN(lowerBinId));
    const upperArrayIdx = binIdToBinArrayIndex(new BN(upperBinId));
    const uniqueArrayIdxs =
      lowerArrayIdx.eq(upperArrayIdx) ? [lowerArrayIdx] : [lowerArrayIdx, upperArrayIdx];

    const binArrayIxs = await dlmm.initializeBinArrays(uniqueArrayIdxs, this.relayer.publicKey);
    if (binArrayIxs.length > 0) {
      await this.provider.sendAndConfirm(
        new Transaction().add(...binArrayIxs),
        [this.relayer],
      );
    }

    const [binArrayLower] = deriveBinArray(args.lbPair, lowerArrayIdx, DLMM_PROGRAM_ID);
    const [binArrayUpper] = deriveBinArray(args.lbPair, upperArrayIdx, DLMM_PROGRAM_ID);

    return {
      tokenX: tokenX.toBase58(),
      tokenY: tokenY.toBase58(),
      lbPair: args.lbPair.toBase58(),
      binArrayLower: binArrayLower.toBase58(),
      binArrayUpper: binArrayUpper.toBase58(),
      lowerBinId,
      upperBinId,
      width,
      activeBin,
      binStep,
      // baseFactor isn't strictly needed once the pair exists, but we keep
      // it on the config so the shape is identical to setupTestPair output.
      // Real value isn't readable cheaply from the LB pair account alone;
      // the consumer doesn't read it after pair creation, so 0 is safe.
      baseFactor: 0,
    };
  }

  /** Mint test tokens to the given wallet's ATAs. Server signs with its mint authority. */
  async mintTestTokens(args: {
    owner: PublicKey;
    tokenX: PublicKey;
    tokenY: PublicKey;
    amountX: bigint;
    amountY: bigint;
  }): Promise<{ ataX: string; ataY: string }> {
    const ataX = await getOrCreateAssociatedTokenAccount(
      this.connection, this.relayer, args.tokenX, args.owner,
    );
    const ataY = await getOrCreateAssociatedTokenAccount(
      this.connection, this.relayer, args.tokenY, args.owner,
    );
    if (args.amountX > 0n) {
      await mintTo(
        this.connection, this.relayer, args.tokenX, ataX.address,
        this.relayer.publicKey, args.amountX,
      );
    }
    if (args.amountY > 0n) {
      await mintTo(
        this.connection, this.relayer, args.tokenY, ataY.address,
        this.relayer.publicKey, args.amountY,
      );
    }
    return { ataX: ataX.address.toBase58(), ataY: ataY.address.toBase58() };
  }

  /**
   * Build an unsigned `init_position` tx.
   *
   * Server pre-signs as fee payer + position keypair (a fresh, single-use
   * keypair for the DLMM Position account). The browser only needs to add
   * the stealth wallet's signature before sending.
   *
   * Returns the partially-signed tx and the position pubkey so the browser
   * can record it for later add_liquidity / withdraw_close calls.
   */
  async buildInitPositionTx(args: {
    stealth: PublicKey;
    lbPair: PublicKey;
    exitRecipient: PublicKey;
    lowerBinId: number;
    width: number;
  }): Promise<{ transaction: string; positionPubkey: string; positionAuthority: string }> {
    const positionKeypair = Keypair.generate();
    const [positionAuthority] = PublicKey.findProgramAddressSync(
      [POSITION_AUTHORITY_SEED, args.stealth.toBuffer()],
      this.programId,
    );

    const ix = await this.program.methods
      .initPosition(args.lowerBinId, args.width, args.exitRecipient)
      .accounts({
        stealth: args.stealth,
        positionAuthority,
        dlmmProgram: DLMM_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: this.relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: positionKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: args.lbPair, isSigner: false, isWritable: false },
        { pubkey: positionAuthority, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ])
      .instruction();

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: this.relayer.publicKey });
    tx.add(computeIx, ix);

    // Server pre-signs with its two known signers (relayer + position kp).
    // The remaining stealth signature is added in the browser.
    tx.partialSign(this.relayer, positionKeypair);

    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return {
      transaction: serialized.toString("base64"),
      positionPubkey: positionKeypair.publicKey.toBase58(),
      positionAuthority: positionAuthority.toBase58(),
    };
  }

  /**
   * Build an unsigned `add_liquidity` tx that combines:
   *   1. Token transfers from the user's ATAs into the PDA-owned escrow ATAs
   *      (DLMM uses sender=PDA as the SPL transfer authority, so the source
   *      ATAs must be PDA-owned — see add_liquidity.rs)
   *   2. The executor's `add_liquidity` ix
   *
   * Required signers at submission: user wallet (for the transfers) + stealth.
   * Server pre-signs as fee payer.
   */
  async buildAddLiquidityTx(args: {
    stealth: PublicKey;
    userOwner: PublicKey;
    config: TestPairConfig;
    amountX: bigint;
    amountY: bigint;
  }): Promise<{ transaction: string }> {
    const tokenX = new PublicKey(args.config.tokenX);
    const tokenY = new PublicKey(args.config.tokenY);
    const lbPair = new PublicKey(args.config.lbPair);
    const binArrayLower = new PublicKey(args.config.binArrayLower);
    const binArrayUpper = new PublicKey(args.config.binArrayUpper);
    const [positionAuthority] = PublicKey.findProgramAddressSync(
      [POSITION_AUTHORITY_SEED, args.stealth.toBuffer()],
      this.programId,
    );

    // PDA-owned escrow ATAs (idempotent — created once on first call).
    const pdaAtaX = await getOrCreateAssociatedTokenAccount(
      this.connection, this.relayer, tokenX, positionAuthority, true,
    );
    const pdaAtaY = await getOrCreateAssociatedTokenAccount(
      this.connection, this.relayer, tokenY, positionAuthority, true,
    );

    // User's source ATAs.
    const userAtaX = await getOrCreateAssociatedTokenAccount(
      this.connection, this.relayer, tokenX, args.userOwner,
    );
    const userAtaY = await getOrCreateAssociatedTokenAccount(
      this.connection, this.relayer, tokenY, args.userOwner,
    );

    const transferX = createTransferInstruction(
      userAtaX.address, pdaAtaX.address, args.userOwner, args.amountX,
    );
    const transferY = createTransferInstruction(
      userAtaY.address, pdaAtaY.address, args.userOwner, args.amountY,
    );

    const positionPubkey = await this.fetchPositionFromAuthority(positionAuthority);
    const [reserveX] = deriveReserve(tokenX, lbPair, DLMM_PROGRAM_ID);
    const [reserveY] = deriveReserve(tokenY, lbPair, DLMM_PROGRAM_ID);

    const liquidityParams = encodeLiquidityParamsByStrategy({
      amountX: args.amountX,
      amountY: args.amountY,
      activeId: args.config.activeBin,
      maxActiveBinSlippage: 5,
      minBinId: args.config.lowerBinId,
      maxBinId: args.config.upperBinId,
      strategyType: 6, // spotImBalanced — see happy-path test
    });

    const dlmmAccounts: AccountMeta[] = [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },         // 0 position
      { pubkey: lbPair, isSigner: false, isWritable: true },                 // 1 lb_pair
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },        // 2 bitmap_ext = None
      { pubkey: pdaAtaX.address, isSigner: false, isWritable: true },        // 3 user_token_x (PDA-owned)
      { pubkey: pdaAtaY.address, isSigner: false, isWritable: true },        // 4 user_token_y (PDA-owned)
      { pubkey: reserveX, isSigner: false, isWritable: true },               // 5 reserve_x
      { pubkey: reserveY, isSigner: false, isWritable: true },               // 6 reserve_y
      { pubkey: tokenX, isSigner: false, isWritable: false },                // 7 token_x_mint
      { pubkey: tokenY, isSigner: false, isWritable: false },                // 8 token_y_mint
      { pubkey: binArrayLower, isSigner: false, isWritable: true },          // 9 bin_array_lower
      { pubkey: binArrayUpper, isSigner: false, isWritable: true },          // 10 bin_array_upper
      { pubkey: positionAuthority, isSigner: false, isWritable: false },     // 11 sender
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // 12 token_x_program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // 13 token_y_program
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },  // 14 event_authority
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },       // 15 program
    ];

    const addLiqIx = await this.program.methods
      .addLiquidity(Buffer.from(liquidityParams))
      .accounts({
        stealth: args.stealth,
        positionAuthority,
        dlmmProgram: DLMM_PROGRAM_ID,
      })
      .remainingAccounts(dlmmAccounts)
      .instruction();

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: this.relayer.publicKey });
    tx.add(computeIx, transferX, transferY, addLiqIx);
    tx.partialSign(this.relayer);

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    return { transaction: serialized.toString("base64") };
  }

  /** Build an unsigned `withdraw_close` tx that exits the full position to exit_recipient ATAs. */
  async buildWithdrawCloseTx(args: {
    stealth: PublicKey;
    exitRecipient: PublicKey;
    config: TestPairConfig;
  }): Promise<{ transaction: string }> {
    const tokenX = new PublicKey(args.config.tokenX);
    const tokenY = new PublicKey(args.config.tokenY);
    const lbPair = new PublicKey(args.config.lbPair);
    const binArrayLower = new PublicKey(args.config.binArrayLower);
    const binArrayUpper = new PublicKey(args.config.binArrayUpper);
    const [positionAuthority] = PublicKey.findProgramAddressSync(
      [POSITION_AUTHORITY_SEED, args.stealth.toBuffer()],
      this.programId,
    );

    const exitAtaX = await getOrCreateAssociatedTokenAccount(
      this.connection, this.relayer, tokenX, args.exitRecipient,
    );
    const exitAtaY = await getOrCreateAssociatedTokenAccount(
      this.connection, this.relayer, tokenY, args.exitRecipient,
    );

    const positionPubkey = await this.fetchPositionFromAuthority(positionAuthority);
    const [reserveX] = deriveReserve(tokenX, lbPair, DLMM_PROGRAM_ID);
    const [reserveY] = deriveReserve(tokenY, lbPair, DLMM_PROGRAM_ID);

    const dlmmAccounts: AccountMeta[] = [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },         // 0 position
      { pubkey: lbPair, isSigner: false, isWritable: true },                 // 1 lb_pair
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: true },        // 2 bitmap_ext = None
      { pubkey: exitAtaX.address, isSigner: false, isWritable: true },       // 3 user_token_x (exit_recipient)
      { pubkey: exitAtaY.address, isSigner: false, isWritable: true },       // 4 user_token_y (exit_recipient)
      { pubkey: reserveX, isSigner: false, isWritable: true },               // 5 reserve_x
      { pubkey: reserveY, isSigner: false, isWritable: true },               // 6 reserve_y
      { pubkey: tokenX, isSigner: false, isWritable: false },                // 7 token_x_mint
      { pubkey: tokenY, isSigner: false, isWritable: false },                // 8 token_y_mint
      { pubkey: binArrayLower, isSigner: false, isWritable: true },          // 9 bin_array_lower
      { pubkey: binArrayUpper, isSigner: false, isWritable: true },          // 10 bin_array_upper
      { pubkey: positionAuthority, isSigner: false, isWritable: false },     // 11 sender
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // 12 token_x_program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // 13 token_y_program
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },  // 14 event_authority
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },       // 15 program
      { pubkey: args.exitRecipient, isSigner: false, isWritable: true },     // 16 rent_receiver
    ];

    const ix = await this.program.methods
      .withdrawClose(args.config.lowerBinId, args.config.upperBinId, 10000)
      .accounts({
        stealth: args.stealth,
        positionAuthority,
        dlmmProgram: DLMM_PROGRAM_ID,
      })
      .remainingAccounts(dlmmAccounts)
      .instruction();

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: this.relayer.publicKey });
    tx.add(computeIx, ix);
    tx.partialSign(this.relayer);

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    return { transaction: serialized.toString("base64") };
  }

  async fetchPositionAuthority(stealth: PublicKey): Promise<{
    pda: string;
    stealthPubkey: string;
    lbPair: string;
    position: string;
    exitRecipient: string;
  } | null> {
    const [pda] = PublicKey.findProgramAddressSync(
      [POSITION_AUTHORITY_SEED, stealth.toBuffer()],
      this.programId,
    );
    const acct = await (this.program.account as any).positionAuthority.fetchNullable(pda);
    if (!acct) return null;
    return {
      pda: pda.toBase58(),
      stealthPubkey: acct.stealthPubkey.toBase58(),
      lbPair: acct.lbPair.toBase58(),
      position: acct.position.toBase58(),
      exitRecipient: acct.exitRecipient.toBase58(),
    };
  }

  /** Internal: read the PositionAuthority PDA to recover the position pubkey. */
  private async fetchPositionFromAuthority(pda: PublicKey): Promise<PublicKey> {
    const acct = await (this.program.account as any).positionAuthority.fetch(pda);
    return acct.position as PublicKey;
  }
}

/**
 * Borsh-encode `LiquidityParameterByStrategy` as DLMM's IDL specifies.
 * Mirrors the same helper in tests/octora-executor-happy-path.ts.
 */
function encodeLiquidityParamsByStrategy(p: {
  amountX: bigint;
  amountY: bigint;
  activeId: number;
  maxActiveBinSlippage: number;
  minBinId: number;
  maxBinId: number;
  strategyType: number;
}): Buffer {
  const buf = Buffer.alloc(97);
  let o = 0;
  buf.writeBigUInt64LE(p.amountX, o); o += 8;
  buf.writeBigUInt64LE(p.amountY, o); o += 8;
  buf.writeInt32LE(p.activeId, o); o += 4;
  buf.writeInt32LE(p.maxActiveBinSlippage, o); o += 4;
  buf.writeInt32LE(p.minBinId, o); o += 4;
  buf.writeInt32LE(p.maxBinId, o); o += 4;
  buf.writeUInt8(p.strategyType, o); o += 1;
  // parameteres [u8; 64] zero-filled.
  return buf;
}
