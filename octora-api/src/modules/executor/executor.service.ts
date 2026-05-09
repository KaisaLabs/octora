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
  NATIVE_MINT,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  planSingleSidedSol,
  encodeLiquidityParamsByStrategy,
  type DistributionShape,
} from "./single-sided.js";
import DLMM, {
  binIdToBinArrayIndex,
  deriveBinArray,
  deriveLbPair2,
  deriveReserve,
} from "@meteora-ag/dlmm";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPrices } from "#modules/prices";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDL_PATH = join(__dirname, "..", "execution", "clients", "idl", "octora_executor.json");

const POOL_AUTHORITY_SEED = Buffer.from("pool-authority");
const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const DLMM_EVENT_AUTHORITY = new PublicKey("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");
// preset_parameter PDA at v2-style seeds with v1 layout — see the
// happy-path test for context. binStep=10, baseFactor=10000.
const PRESET_PARAMETER = new PublicKey("BYQtcDyv2BoFuf5ghsYDGPA8iX5F4WquK7zCzUsDwJ63");
const BIN_STEP = 10;
const BASE_FACTOR = 10000;
const ACTIVE_BIN = 0;

/**
 * Lamports the relayer drops on the stealth wallet inside `dlmm_init_position`
 * so it can pay rent for its own PoolAuthority PDA. Sized comfortably above
 * the observed PoolAuthority rent (~2.074M lamports) to leave headroom for
 * any small PDA fees the on-chain handler might bill the stealth for.
 */
const STEALTH_INIT_FUNDING_LAMPORTS = 5_000_000;

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
    /**
     * When true, pair the test mint against native SOL (Wrapped SOL) instead
     * of generating two fresh mints. Required for the private-deposit flow,
     * which only supports SOL-paired pools (see `buildAddLiquidityTx`).
     */
    useNativeSol?: boolean;
  } = {}): Promise<TestPairConfig> {
    const lowerBinId = opts.lowerBinId ?? -10;
    const width = opts.width ?? 20;
    const upperBinId = lowerBinId + width - 1;

    // ── Mints ────────────────────────────────────────────────────────
    let tokenX: PublicKey;
    let tokenY: PublicKey;
    if (opts.useNativeSol) {
      tokenX = await createMint(this.connection, this.relayer, this.relayer.publicKey, null, 6);
      tokenY = NATIVE_MINT;
    } else {
      tokenX = await createMint(this.connection, this.relayer, this.relayer.publicKey, null, 6);
      tokenY = await createMint(this.connection, this.relayer, this.relayer.publicKey, null, 6);
    }
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
    /**
     * Explicit lower bin id. When omitted, the position is centred on the
     * pool's active bin (the test-page default). The deposit UX passes a
     * user-selected lower bin from the BinLiquidityChart.
     */
    lowerBinId?: number;
  }): Promise<TestPairConfig> {
    const width = args.width ?? 20;
    const dlmm = await DLMM.create(this.connection, args.lbPair);

    const tokenX = dlmm.lbPair.tokenXMint;
    const tokenY = dlmm.lbPair.tokenYMint;
    const activeBin = dlmm.lbPair.activeId;
    const binStep = dlmm.lbPair.binStep;

    let lowerBinId =
      args.lowerBinId ?? activeBin - Math.floor(width / 2);
    let upperBinId = lowerBinId + width - 1;

    let lowerArrayIdx = binIdToBinArrayIndex(new BN(lowerBinId));
    let upperArrayIdx = binIdToBinArrayIndex(new BN(upperBinId));

    // DLMM's add_liquidity_by_strategy CPI takes bin_array_lower and
    // bin_array_upper as two distinct writable accounts. When the position
    // fits inside a single bin array (70 bins), both PDAs resolve to the
    // same account, the runtime hands DLMM the same RefCell at indices 9
    // and 10, and the handler fails with AccountBorrowFailed when it tries
    // to mutably borrow both. Extend the position into a neighbouring array
    // so the two accounts are always distinct. The new bins stay empty
    // for single-sided SOL positions, so this widens *capacity* without
    // changing the liquidity footprint — but the extension must go in the
    // direction *away* from the active bin, otherwise we cross active and
    // break the single-sided invariant enforced by `planSingleSidedSol`.
    // Meteora DLMM: position width must be in [1, MAX_BIN_PER_POSITION].
    // MAX is 70 (one bin array). Our extension adds 1 bin in the neighbour
    // array, so we must trim the original side by 1 in the worst case
    // (when the user's range already fills its bin array end-to-end) to
    // stay within the cap.
    const MAX_WIDTH = 70;
    if (lowerArrayIdx.eq(upperArrayIdx)) {
      const aboveActive = lowerBinId > activeBin;
      const belowActive = upperBinId < activeBin;
      if (belowActive) {
        // Y-side single-sided (SOL on Y, all bins below active): extend
        // lowerBinId down into the previous array.
        lowerBinId = lowerArrayIdx.toNumber() * 70 - 1;
        if (upperBinId - lowerBinId + 1 > MAX_WIDTH) {
          upperBinId = lowerBinId + MAX_WIDTH - 1;
        }
        lowerArrayIdx = binIdToBinArrayIndex(new BN(lowerBinId));
        upperArrayIdx = binIdToBinArrayIndex(new BN(upperBinId));
      } else if (aboveActive) {
        // X-side single-sided (SOL on X, all bins above active): extend
        // upperBinId up into the next array.
        upperBinId = upperArrayIdx.add(new BN(1)).toNumber() * 70;
        if (upperBinId - lowerBinId + 1 > MAX_WIDTH) {
          lowerBinId = upperBinId - MAX_WIDTH + 1;
        }
        lowerArrayIdx = binIdToBinArrayIndex(new BN(lowerBinId));
        upperArrayIdx = binIdToBinArrayIndex(new BN(upperBinId));
      } else {
        // Straddles active — extension direction doesn't matter for the
        // single-sided check; widen upward by convention.
        upperBinId = upperArrayIdx.add(new BN(1)).toNumber() * 70;
        if (upperBinId - lowerBinId + 1 > MAX_WIDTH) {
          lowerBinId = upperBinId - MAX_WIDTH + 1;
        }
        lowerArrayIdx = binIdToBinArrayIndex(new BN(lowerBinId));
        upperArrayIdx = binIdToBinArrayIndex(new BN(upperBinId));
      }
    }
    const adjustedWidth = upperBinId - lowerBinId + 1;

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
      width: adjustedWidth,
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
   *
   * Idempotent on (stealth, lb_pair): the stealth pubkey is deterministically
   * derived from (mainWallet sig, pool) on the client, so a retry after a
   * partial failure produces the same `positionAuthority` PDA. If that PDA
   * already exists, return the existing position info with `alreadyInitialized:
   * true` and `transaction: null` so the caller skips the on-chain init step
   * and proceeds straight to add_liquidity.
   */
  async buildInitPositionTx(args: {
    stealth: PublicKey;
    lbPair: PublicKey;
    exitRecipient: PublicKey;
    lowerBinId: number;
    width: number;
  }): Promise<{
    transaction: string | null;
    positionPubkey: string;
    positionAuthority: string;
    alreadyInitialized: boolean;
  }> {
    const [positionAuthority] = derivePoolAuthorityPda(this.programId, args.stealth, args.lbPair);

    const existing = await this.connection.getAccountInfo(positionAuthority);
    if (existing) {
      const positionPubkey = await this.fetchPositionFromAuthority(positionAuthority);
      return {
        transaction: null,
        positionPubkey: positionPubkey.toBase58(),
        positionAuthority: positionAuthority.toBase58(),
        alreadyInitialized: true,
      };
    }

    const positionKeypair = Keypair.generate();

    // The on-chain `dlmm_init_position` ix uses `payer = stealth`, so the
    // stealth account must hold enough lamports to cover the PoolAuthority
    // PDA rent. Stealth is a fresh wallet-derived keypair with 0 SOL on
    // chain, so we top it up from the relayer in the same tx. The lamports
    // come back to the user via `close = stealth` in withdraw_close.
    const fundStealthIx = SystemProgram.transfer({
      fromPubkey: this.relayer.publicKey,
      toPubkey: args.stealth,
      lamports: STEALTH_INIT_FUNDING_LAMPORTS,
    });

    const ix = await this.program.methods
      .dlmmInitPosition(args.lowerBinId, args.width, args.exitRecipient)
      .accounts({
        stealth: args.stealth,
        poolAuthority: positionAuthority,
        lbPair: args.lbPair,
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
    tx.add(computeIx, fundStealthIx, ix);

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
      alreadyInitialized: false,
    };
  }

  /**
   * Build an unsigned `add_liquidity` tx for a single-sided SOL deposit.
   *
   * The stealth wallet is funded by a prior mixer.withdraw, so it owns the
   * SOL outright — there's no user wallet co-signature on this tx, which
   * is the whole point of the privacy boundary. Sequence:
   *
   *   1. create both PDA-owned ATAs (DLMM requires both, even when one is empty)
   *   2. create stealth WSOL ATA (idempotent), wrap stealth SOL into it
   *   3. spl-token transfer stealth WSOL ATA → PDA WSOL ATA (stealth signs)
   *   4. close stealth WSOL ATA → rent back to stealth
   *   5. executor.dlmm_add_liquidity (stealth signs as PoolAuthority owner)
   *
   * Required signers at submission: stealth only (server pre-signs as fee payer).
   */
  async buildAddLiquidityTx(args: {
    stealth: PublicKey;
    config: TestPairConfig;
    /** Total SOL deposit in lamports. Must equal the mixer pool denomination. */
    totalSolLamports: bigint;
    /** Distribution shape selected in the deposit form. */
    shape: DistributionShape;
  }): Promise<{ transaction: string }> {
    const tokenX = new PublicKey(args.config.tokenX);
    const tokenY = new PublicKey(args.config.tokenY);
    const lbPair = new PublicKey(args.config.lbPair);
    const binArrayLower = new PublicKey(args.config.binArrayLower);
    const binArrayUpper = new PublicKey(args.config.binArrayUpper);
    const [positionAuthority] = derivePoolAuthorityPda(this.programId, args.stealth, lbPair);

    const solIsTokenX = tokenX.equals(NATIVE_MINT);
    const solIsTokenY = tokenY.equals(NATIVE_MINT);
    if (!solIsTokenX && !solIsTokenY) {
      throw new Error(
        "Pool must include the native SOL mint (Wrapped SOL) on one side for the single-sided SOL flow.",
      );
    }

    const plan = planSingleSidedSol({
      totalLamports: args.totalSolLamports,
      activeBinId: args.config.activeBin,
      lowerBinId: args.config.lowerBinId,
      upperBinId: args.config.upperBinId,
      shape: args.shape,
      solIsTokenX,
    });

    const positionPubkey = await this.fetchPositionFromAuthority(positionAuthority);
    const [reserveX] = deriveReserve(tokenX, lbPair, DLMM_PROGRAM_ID);
    const [reserveY] = deriveReserve(tokenY, lbPair, DLMM_PROGRAM_ID);

    // PDA-owned escrow ATAs. Both must exist for DLMM CPI even when one
    // side is empty. Issued idempotently so a re-run after a confirmed
    // first attempt doesn't blow up.
    const pdaAtaX = getAssociatedTokenAddressSync(tokenX, positionAuthority, true);
    const pdaAtaY = getAssociatedTokenAddressSync(tokenY, positionAuthority, true);
    const createPdaAtaXIx = createAssociatedTokenAccountIdempotentInstruction(
      this.relayer.publicKey, pdaAtaX, positionAuthority, tokenX,
    );
    const createPdaAtaYIx = createAssociatedTokenAccountIdempotentInstruction(
      this.relayer.publicKey, pdaAtaY, positionAuthority, tokenY,
    );

    // Wrap stealth's SOL through a stealth-owned WSOL ATA before transferring
    // to the PDA. Routing through a stealth ATA keeps the stealth's signature
    // visible on the wrap and lets us close the temp ATA at the end so rent
    // comes back to the stealth.
    const stealthWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, args.stealth);
    const createStealthWsolAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      this.relayer.publicKey, stealthWsolAta, args.stealth, NATIVE_MINT,
    );
    const fundWsolIx = SystemProgram.transfer({
      fromPubkey: args.stealth,
      toPubkey: stealthWsolAta,
      lamports: args.totalSolLamports,
    });
    const syncWsolIx = createSyncNativeInstruction(stealthWsolAta);

    const pdaSolAta = solIsTokenX ? pdaAtaX : pdaAtaY;
    const transferToPdaIx = createTransferInstruction(
      stealthWsolAta, pdaSolAta, args.stealth, args.totalSolLamports,
    );
    const closeStealthWsolIx = createCloseAccountInstruction(
      stealthWsolAta, args.stealth, args.stealth,
    );

    const liquidityParams = encodeLiquidityParamsByStrategy({
      amountX: plan.amountX,
      amountY: plan.amountY,
      activeId: args.config.activeBin,
      maxActiveBinSlippage: 5,
      minBinId: plan.minBinId,
      maxBinId: plan.maxBinId,
      strategyType: plan.strategyType,
    });

    const dlmmAccounts: AccountMeta[] = [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },         // 0 position
      { pubkey: lbPair, isSigner: false, isWritable: true },                 // 1 lb_pair
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },       // 2 bitmap_ext = None (sentinel)
      { pubkey: pdaAtaX, isSigner: false, isWritable: true },                // 3 user_token_x (PDA-owned)
      { pubkey: pdaAtaY, isSigner: false, isWritable: true },                // 4 user_token_y (PDA-owned)
      { pubkey: reserveX, isSigner: false, isWritable: true },               // 5 reserve_x
      { pubkey: reserveY, isSigner: false, isWritable: true },               // 6 reserve_y
      { pubkey: tokenX, isSigner: false, isWritable: false },                // 7 token_x_mint
      { pubkey: tokenY, isSigner: false, isWritable: false },                // 8 token_y_mint
      { pubkey: binArrayLower, isSigner: false, isWritable: true },          // 9 bin_array_lower
      { pubkey: binArrayUpper, isSigner: false, isWritable: true },          // 10 bin_array_upper
      { pubkey: positionAuthority, isSigner: false, isWritable: false },     // 11 sender
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // 12 token_x_program  // MAINNET_BLOCKER: Token-2022
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // 13 token_y_program  // MAINNET_BLOCKER: Token-2022
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },  // 14 event_authority
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },       // 15 program
    ];

    const addLiqIx = await this.program.methods
      .dlmmAddLiquidity(Buffer.from(liquidityParams))
      .accounts({
        stealth: args.stealth,
        poolAuthority: positionAuthority,
        dlmmProgram: DLMM_PROGRAM_ID,
        lbPair,
      })
      .remainingAccounts(dlmmAccounts)
      .instruction();

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: this.relayer.publicKey });
    tx.add(
      computeIx,
      createPdaAtaXIx,
      createPdaAtaYIx,
      createStealthWsolAtaIx,
      fundWsolIx,
      syncWsolIx,
      transferToPdaIx,
      closeStealthWsolIx,
      addLiqIx,
    );
    tx.partialSign(this.relayer);

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    return { transaction: serialized.toString("base64") };
  }

  /**
   * Build an unsigned `dlmm_claim_fees` tx. Fees flow to the PoolAuthority's
   * stored `exit_recipient` ATAs (set at init_position time, immutable).
   *
   * Required signer at submission: stealth only. Server pre-signs as fee payer.
   */
  async buildClaimFeesTx(args: {
    stealth: PublicKey;
    config: TestPairConfig;
  }): Promise<{ transaction: string; exitRecipient: string }> {
    const tokenX = new PublicKey(args.config.tokenX);
    const tokenY = new PublicKey(args.config.tokenY);
    const lbPair = new PublicKey(args.config.lbPair);
    const binArrayLower = new PublicKey(args.config.binArrayLower);
    const binArrayUpper = new PublicKey(args.config.binArrayUpper);
    const [positionAuthority] = derivePoolAuthorityPda(this.programId, args.stealth, lbPair);

    const acct = await (this.program.account as any).poolAuthority.fetch(positionAuthority);
    const exitRecipient = acct.exitRecipient as PublicKey;
    const positionPubkey = await this.fetchPositionFromAuthority(positionAuthority);
    const [reserveX] = deriveReserve(tokenX, lbPair, DLMM_PROGRAM_ID);
    const [reserveY] = deriveReserve(tokenY, lbPair, DLMM_PROGRAM_ID);

    // exit_recipient ATAs (idempotent create paid by relayer fee payer).
    const exitAtaX = getAssociatedTokenAddressSync(tokenX, exitRecipient);
    const exitAtaY = getAssociatedTokenAddressSync(tokenY, exitRecipient);
    const createExitAtaXIx = createAssociatedTokenAccountIdempotentInstruction(
      this.relayer.publicKey, exitAtaX, exitRecipient, tokenX,
    );
    const createExitAtaYIx = createAssociatedTokenAccountIdempotentInstruction(
      this.relayer.publicKey, exitAtaY, exitRecipient, tokenY,
    );

    // Account order matches the on-chain handler's index assertions —
    // see programs/octora-executor/src/instructions/dlmm/claim_fees.rs.
    //
    // MAINNET_BLOCKER: token_program is hardcoded to classic SPL-Token. On
    // mainnet DLMM has Token-2022 pools (e.g. some PYUSD, JUP-extension
    // pairs); both the program-id account and the ATA derivation must
    // branch per-side based on `mintAccount.owner`. See docs/test-plan.md
    // §14 for the pre-mainnet checklist.
    const dlmmAccounts: AccountMeta[] = [
      { pubkey: lbPair, isSigner: false, isWritable: true },                 // 0 lb_pair
      { pubkey: positionPubkey, isSigner: false, isWritable: true },         // 1 position
      { pubkey: binArrayLower, isSigner: false, isWritable: true },          // 2 bin_array_lower
      { pubkey: binArrayUpper, isSigner: false, isWritable: true },          // 3 bin_array_upper
      { pubkey: positionAuthority, isSigner: false, isWritable: false },     // 4 sender (re-pinned to PA on-chain)
      { pubkey: reserveX, isSigner: false, isWritable: true },               // 5 reserve_x
      { pubkey: reserveY, isSigner: false, isWritable: true },               // 6 reserve_y
      { pubkey: exitAtaX, isSigner: false, isWritable: true },               // 7 user_token_x (exit_recipient)
      { pubkey: exitAtaY, isSigner: false, isWritable: true },               // 8 user_token_y (exit_recipient)
      { pubkey: tokenX, isSigner: false, isWritable: false },                // 9 token_x_mint
      { pubkey: tokenY, isSigner: false, isWritable: false },                // 10 token_y_mint
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // 11 token_program  // MAINNET_BLOCKER: Token-2022
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },  // 12 event_authority
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },       // 13 dlmm_program
    ];

    const ix = await this.program.methods
      .dlmmClaimFees()
      .accounts({
        stealth: args.stealth,
        poolAuthority: positionAuthority,
        lbPair,
        dlmmProgram: DLMM_PROGRAM_ID,
      })
      .remainingAccounts(dlmmAccounts)
      .instruction();

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: this.relayer.publicKey });
    tx.add(computeIx, createExitAtaXIx, createExitAtaYIx, ix);
    tx.partialSign(this.relayer);

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    return {
      transaction: serialized.toString("base64"),
      exitRecipient: exitRecipient.toBase58(),
    };
  }

  /**
   * Build an unsigned `withdraw_close` tx that fully exits the position
   * (BPS=10000). Exit recipient is read from the PoolAuthority (set at init)
   * — caller cannot redirect funds, which is the privacy boundary.
   *
   * Required signer at submission: stealth only. Server pre-signs as fee payer.
   */
  async buildWithdrawCloseTx(args: {
    stealth: PublicKey;
    config: TestPairConfig;
  }): Promise<{ transaction: string; exitRecipient: string }> {
    const tokenX = new PublicKey(args.config.tokenX);
    const tokenY = new PublicKey(args.config.tokenY);
    const lbPair = new PublicKey(args.config.lbPair);
    const binArrayLower = new PublicKey(args.config.binArrayLower);
    const binArrayUpper = new PublicKey(args.config.binArrayUpper);
    const [positionAuthority] = derivePoolAuthorityPda(this.programId, args.stealth, lbPair);

    const acct = await (this.program.account as any).poolAuthority.fetch(positionAuthority);
    const exitRecipient = acct.exitRecipient as PublicKey;

    const exitAtaX = getAssociatedTokenAddressSync(tokenX, exitRecipient);
    const exitAtaY = getAssociatedTokenAddressSync(tokenY, exitRecipient);
    const createExitAtaXIx = createAssociatedTokenAccountIdempotentInstruction(
      this.relayer.publicKey, exitAtaX, exitRecipient, tokenX,
    );
    const createExitAtaYIx = createAssociatedTokenAccountIdempotentInstruction(
      this.relayer.publicKey, exitAtaY, exitRecipient, tokenY,
    );

    const positionPubkey = await this.fetchPositionFromAuthority(positionAuthority);
    const [reserveX] = deriveReserve(tokenX, lbPair, DLMM_PROGRAM_ID);
    const [reserveY] = deriveReserve(tokenY, lbPair, DLMM_PROGRAM_ID);

    // MAINNET_BLOCKER: token_x_program / token_y_program hardcoded to classic
    // SPL-Token. Token-2022 pools require per-side branching off
    // `mintAccount.owner` plus matching ATA derivation. See docs/test-plan.md §14.
    const dlmmAccounts: AccountMeta[] = [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },         // 0 position
      { pubkey: lbPair, isSigner: false, isWritable: true },                 // 1 lb_pair
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },       // 2 bitmap_ext = None (sentinel)
      { pubkey: exitAtaX, isSigner: false, isWritable: true },               // 3 user_token_x (exit_recipient)
      { pubkey: exitAtaY, isSigner: false, isWritable: true },               // 4 user_token_y (exit_recipient)
      { pubkey: reserveX, isSigner: false, isWritable: true },               // 5 reserve_x
      { pubkey: reserveY, isSigner: false, isWritable: true },               // 6 reserve_y
      { pubkey: tokenX, isSigner: false, isWritable: false },                // 7 token_x_mint
      { pubkey: tokenY, isSigner: false, isWritable: false },                // 8 token_y_mint
      { pubkey: binArrayLower, isSigner: false, isWritable: true },          // 9 bin_array_lower
      { pubkey: binArrayUpper, isSigner: false, isWritable: true },          // 10 bin_array_upper
      { pubkey: positionAuthority, isSigner: false, isWritable: false },     // 11 sender
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // 12 token_x_program  // MAINNET_BLOCKER: Token-2022
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // 13 token_y_program  // MAINNET_BLOCKER: Token-2022
      { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },  // 14 event_authority
      { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },       // 15 program
      { pubkey: exitRecipient, isSigner: false, isWritable: true },          // 16 rent_receiver
    ];

    const ix = await this.program.methods
      .dlmmWithdrawClose(args.config.lowerBinId, args.config.upperBinId, 10000)
      .accounts({
        stealth: args.stealth,
        poolAuthority: positionAuthority,
        lbPair,
        dlmmProgram: DLMM_PROGRAM_ID,
      })
      .remainingAccounts(dlmmAccounts)
      .instruction();

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: this.relayer.publicKey });
    tx.add(computeIx, createExitAtaXIx, createExitAtaYIx, ix);
    tx.partialSign(this.relayer);

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    return {
      transaction: serialized.toString("base64"),
      exitRecipient: exitRecipient.toBase58(),
    };
  }

  async fetchPositionAuthority(
    stealth: PublicKey,
    lbPair: PublicKey,
  ): Promise<{
    pda: string;
    stealthPubkey: string;
    lbPair: string;
    position: string;
    exitRecipient: string;
    /** On-chain DLMM position bin range — populated when the position account
     *  is decodable. The pool detail page uses this so the user doesn't have
     *  to remember the original deposit range to claim or withdraw. */
    lowerBinId?: number;
    upperBinId?: number;
    width?: number;
    /** Pool token mints + bin-array PDAs covering the position. Same shape
     *  as `useExistingPool` returns so the frontend can hand the result
     *  straight to /executor/{claim-fees,withdraw-close}-tx. */
    tokenX?: string;
    tokenY?: string;
    binArrayLower?: string;
    binArrayUpper?: string;
    activeBin?: number;
    binStep?: number;
  } | null> {
    const [pda] = derivePoolAuthorityPda(this.programId, stealth, lbPair);
    const acct = await (this.program.account as any).poolAuthority.fetchNullable(pda);
    if (!acct) return null;
    const dlmm = acct.poolRef?.dlmm;
    if (!dlmm) return null;

    // Best-effort: read the on-chain position to recover the deposit's
    // bin range. Failures are tolerated (returns the base shape) so the
    // endpoint stays useful when DLMM RPCs are flaky.
    let extras: Partial<{
      lowerBinId: number;
      upperBinId: number;
      width: number;
      tokenX: string;
      tokenY: string;
      binArrayLower: string;
      binArrayUpper: string;
      activeBin: number;
      binStep: number;
    }> = {};
    try {
      const dlmmInstance = await DLMM.create(this.connection, lbPair);
      const lbPosition = await dlmmInstance.getPosition(dlmm.position as PublicKey);
      const lowerBinId = lbPosition.positionData.lowerBinId;
      const upperBinId = lbPosition.positionData.upperBinId;
      const lowerArrayIdx = binIdToBinArrayIndex(new BN(lowerBinId));
      const upperArrayIdx = binIdToBinArrayIndex(new BN(upperBinId));
      const [binArrayLower] = deriveBinArray(lbPair, lowerArrayIdx, DLMM_PROGRAM_ID);
      const [binArrayUpper] = deriveBinArray(lbPair, upperArrayIdx, DLMM_PROGRAM_ID);
      extras = {
        lowerBinId,
        upperBinId,
        width: upperBinId - lowerBinId + 1,
        tokenX: dlmmInstance.lbPair.tokenXMint.toBase58(),
        tokenY: dlmmInstance.lbPair.tokenYMint.toBase58(),
        binArrayLower: binArrayLower.toBase58(),
        binArrayUpper: binArrayUpper.toBase58(),
        activeBin: dlmmInstance.lbPair.activeId,
        binStep: dlmmInstance.lbPair.binStep,
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[fetchPositionAuthority] could not decode DLMM position; returning base shape:",
        err instanceof Error ? err.message : err,
      );
    }

    return {
      pda: pda.toBase58(),
      stealthPubkey: acct.stealthPubkey.toBase58(),
      lbPair: dlmm.lbPair.toBase58(),
      position: dlmm.position.toBase58(),
      exitRecipient: acct.exitRecipient.toBase58(),
      ...extras,
    };
  }

  /** Internal: read the PoolAuthority PDA to recover the DLMM position pubkey. */
  private async fetchPositionFromAuthority(pda: PublicKey): Promise<PublicKey> {
    const acct = await (this.program.account as any).poolAuthority.fetch(pda);
    const dlmm = acct.poolRef?.dlmm;
    if (!dlmm) throw new Error("PoolAuthority is not a DLMM position.");
    return dlmm.position as PublicKey;
  }

  /**
   * Read on-chain Meteora DLMM position state for the portfolio UI.
   *
   * Returns raw amounts plus USD-denominated value/fees so the client can
   * render `value`, `feesEarned`, and `claimable` from real chain state
   * instead of relying on the deposit-time snapshot. Prices come from the
   * existing Jupiter price service; decimals from the mint accounts.
   *
   * Returns `null` when the position account doesn't exist (e.g. closed).
   */
  async getPositionState(args: {
    lbPair: PublicKey;
    positionPubkey: PublicKey;
  }): Promise<PositionStateView | null> {
    const dlmm = await DLMM.create(this.connection, args.lbPair);
    let lbPosition;
    try {
      lbPosition = await dlmm.getPosition(args.positionPubkey);
    } catch {
      // Closed or never-existed → treat as gone so the UI can drop it.
      return null;
    }

    const data = lbPosition.positionData;
    const tokenXMint = dlmm.lbPair.tokenXMint;
    const tokenYMint = dlmm.lbPair.tokenYMint;

    const [decimalsX, decimalsY] = await Promise.all([
      getMintDecimals(this.connection, tokenXMint),
      getMintDecimals(this.connection, tokenYMint),
    ]);

    const prices = await getPrices([tokenXMint.toBase58(), tokenYMint.toBase58()]).catch(
      () => ({}) as Awaited<ReturnType<typeof getPrices>>,
    );
    const priceX = prices[tokenXMint.toBase58()]?.usdPrice ?? 0;
    const priceY = prices[tokenYMint.toBase58()]?.usdPrice ?? 0;

    const feeXRaw = BigInt(data.feeX.toString());
    const feeYRaw = BigInt(data.feeY.toString());
    const totalXRaw = BigInt(data.totalXAmount.split(".")[0]); // SDK returns string with optional decimal
    const totalYRaw = BigInt(data.totalYAmount.split(".")[0]);

    const feeUsdX = rawToUsd(feeXRaw, decimalsX, priceX);
    const feeUsdY = rawToUsd(feeYRaw, decimalsY, priceY);
    const valueUsdX = rawToUsd(totalXRaw, decimalsX, priceX);
    const valueUsdY = rawToUsd(totalYRaw, decimalsY, priceY);

    return {
      positionPubkey: args.positionPubkey.toBase58(),
      lbPair: args.lbPair.toBase58(),
      lowerBinId: data.lowerBinId,
      upperBinId: data.upperBinId,
      activeBinId: dlmm.lbPair.activeId,
      tokenXMint: tokenXMint.toBase58(),
      tokenYMint: tokenYMint.toBase58(),
      decimalsX,
      decimalsY,
      feeXLamports: feeXRaw.toString(),
      feeYLamports: feeYRaw.toString(),
      totalXLamports: totalXRaw.toString(),
      totalYLamports: totalYRaw.toString(),
      feeUsd: feeUsdX + feeUsdY,
      valueUsd: valueUsdX + valueUsdY,
      priceXUsd: priceX,
      priceYUsd: priceY,
    };
  }
}

export interface PositionStateView {
  positionPubkey: string;
  lbPair: string;
  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
  tokenXMint: string;
  tokenYMint: string;
  decimalsX: number;
  decimalsY: number;
  feeXLamports: string;
  feeYLamports: string;
  totalXLamports: string;
  totalYLamports: string;
  feeUsd: number;
  valueUsd: number;
  priceXUsd: number;
  priceYUsd: number;
}

async function getMintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  const info = await connection.getAccountInfo(mint);
  if (!info || info.data.length < 45) return 0;
  // SPL Token mint layout: decimals at byte offset 44 (u8).
  return info.data[44];
}

function rawToUsd(raw: bigint, decimals: number, priceUsd: number): number {
  if (raw === 0n || priceUsd === 0) return 0;
  // Lose precision past 1e15 via Number — fine for display USD numbers.
  const divisor = 10 ** decimals;
  return (Number(raw) / divisor) * priceUsd;
}

/**
 * PoolAuthority PDA seeds match the program's `dlmm/*` handlers:
 *   [POOL_AUTHORITY_SEED, stealth.key(), lb_pair.key()]
 */
function derivePoolAuthorityPda(
  programId: PublicKey,
  stealth: PublicKey,
  lbPair: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POOL_AUTHORITY_SEED, stealth.toBuffer(), lbPair.toBuffer()],
    programId,
  );
}

