import {
  ComputeBudgetProgram,
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
  createTransferInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { deriveReserve } from "@meteora-ag/dlmm";

import {
  planSingleSidedSol,
  encodeLiquidityParamsByStrategy,
  type DistributionShape,
} from "../single-sided.js";
import { derivePoolAuthorityPda } from "./pool-authority.js";
import { resolveMintProgram, type MintProgramInfo } from "./token-program.js";
import type { BuilderContext, TestPairConfig } from "./types.js";

// Meteora v2 ixes (add_liquidity_by_strategy2, claim_fee2,
// remove_liquidity_by_range2, swap2) include a `memo_program` slot in the
// fixed account list. The IDL hardcodes the address constraint to this
// canonical SPL Memo program id, so we pass it directly.
const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

/**
 * Borsh-encoded empty `RemainingAccountsInfo { slices: Vec<...> }`. Used
 * whenever the pool has no transfer-hook'd mints — Anchor expects a u32
 * length prefix (LE), so an empty vec = 4 zero bytes.
 *
 * Hooked mints replace this with a properly-populated buffer + the
 * transfer-hook accounts appended to `remainingAccounts` (Phase C).
 */
const EMPTY_REMAINING_ACCOUNTS_INFO = Buffer.from([0, 0, 0, 0]);

/**
 * Reject mints whose Token-2022 extensions break the single-sided SOL
 * flow as-designed (NonTransferable can't move at all; Confidential mints
 * need a different ix family; PermanentDelegate hands an outside party
 * unilateral seize rights on positions). Throws with a stable message
 * prefix the UI matches on to render a clean error.
 */
function assertSupported(label: "tokenX" | "tokenY", info: MintProgramInfo): void {
  if (info.isToken2022 && info.unsupported) {
    throw new Error(
      `Mint ${label} has unsupported Token-2022 extension: ${info.unsupported}. ` +
        `Pool is not compatible with the private deposit flow.`,
    );
  }
}

/**
 * Block Token-2022 mints that carry a TransferHook extension until the
 * builder appends the hook's ExtraAccountMetaList entries to
 * `remainingAccounts` and populates `RemainingAccountsInfo` accordingly.
 * Plain Token-2022 (no hook) goes through fine on the v2 ix family.
 *
 * Lifted once `expandTransferHookAccounts` lands.
 */
function assertNoTransferHookYet(
  label: "tokenX" | "tokenY",
  info: MintProgramInfo,
): void {
  if (info.isToken2022 && info.hasTransferHook) {
    throw new Error(
      `Mint ${label} is Token-2022 with a TransferHook (program ` +
        `${info.hookProgramId?.toBase58() ?? "unknown"}). ` +
        `Transfer-hook account expansion not yet wired into the v2 builders. ` +
        `Pick a non-hook pool for now.`,
    );
  }
}

/**
 * Lamports the relayer drops on the stealth wallet inside `dlmm_init_position`
 * so it can pay rent for its own PoolAuthority PDA. Sized comfortably above
 * the observed PoolAuthority rent (~2.074M lamports) to leave headroom for
 * any small PDA fees the on-chain handler might bill the stealth for.
 */
const STEALTH_INIT_FUNDING_LAMPORTS = 5_000_000;

/**
 * Builders for the four lifecycle txs (init / add_liquidity / claim_fees /
 * withdraw_close). Each builder pre-signs as fee payer + any server-known
 * signers, then returns a base64-encoded partial Transaction for the
 * browser to add the stealth signature and submit.
 */
export class LiquidityPlanner {
  constructor(private ctx: BuilderContext) {}

  /**
   * Build an unsigned `init_position` tx.
   *
   * Server pre-signs as fee payer + position keypair (a fresh, single-use
   * keypair for the DLMM Position account). The browser only needs to add
   * the stealth wallet's signature before sending.
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
    const { connection, relayer, program, executorProgramId, dlmm } = this.ctx;
    const [positionAuthority] = derivePoolAuthorityPda(executorProgramId, args.stealth, args.lbPair);

    const existing = await connection.getAccountInfo(positionAuthority);
    if (existing) {
      const positionPubkey = await this.fetchPositionFromAuthority(positionAuthority);
      // PoolAuthority can outlive its DLMM Position: if a prior session
      // closed the position via dlmm_withdraw_close but didn't tear down
      // the PA (which is the documented case — close=stealth refunds rent
      // on PA, but the close-PA ix is a separate operation), the next
      // init-position would see PA alive yet point at a now-dead position.
      // The browser would proceed to add_liquidity against a stale pubkey
      // and the on-chain ix would fail with a confusing AccountNotFound.
      // Fail loudly here so the caller knows to wipe stealth state instead.
      const positionAcct = await connection.getAccountInfo(positionPubkey);
      if (!positionAcct) {
        throw new Error(
          `PoolAuthority ${positionAuthority.toBase58()} references a stale DLMM ` +
            `position (${positionPubkey.toBase58()}) that no longer exists on-chain. ` +
            "The position was likely closed in a prior session. Derive a fresh " +
            "stealth wallet or close the PoolAuthority before re-opening.",
        );
      }
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
      fromPubkey: relayer.publicKey,
      toPubkey: args.stealth,
      lamports: STEALTH_INIT_FUNDING_LAMPORTS,
    });

    const ix = await program.methods
      .dlmmInitPosition(args.lowerBinId, args.width, args.exitRecipient)
      .accounts({
        stealth: args.stealth,
        poolAuthority: positionAuthority,
        lbPair: args.lbPair,
        dlmmProgram: dlmm.programId,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: positionKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: args.lbPair, isSigner: false, isWritable: false },
        { pubkey: positionAuthority, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: dlmm.eventAuthority, isSigner: false, isWritable: false },
        { pubkey: dlmm.programId, isSigner: false, isWritable: false },
      ])
      .instruction();

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: relayer.publicKey });
    tx.add(computeIx, fundStealthIx, ix);

    // Server pre-signs with its two known signers (relayer + position kp).
    // The remaining stealth signature is added in the browser.
    tx.partialSign(relayer, positionKeypair);

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
    const { connection, relayer, program, executorProgramId, dlmm } = this.ctx;
    const tokenX = new PublicKey(args.config.tokenX);
    const tokenY = new PublicKey(args.config.tokenY);
    const lbPair = new PublicKey(args.config.lbPair);
    const binArrayLower = new PublicKey(args.config.binArrayLower);
    const binArrayUpper = new PublicKey(args.config.binArrayUpper);
    const [positionAuthority] = derivePoolAuthorityPda(executorProgramId, args.stealth, lbPair);

    const solIsTokenX = tokenX.equals(NATIVE_MINT);
    const solIsTokenY = tokenY.equals(NATIVE_MINT);
    if (!solIsTokenX && !solIsTokenY) {
      throw new Error(
        "Pool must include the native SOL mint (Wrapped SOL) on one side for the single-sided SOL flow.",
      );
    }

    // Resolve token programs per mint. WSOL (NATIVE_MINT) is always legacy
    // SPL Token; the other side may be Token-2022. Reject extensions we
    // can't safely handle (NonTransferable etc.) and TransferHook until
    // Phase C lands.
    const [tokenXInfo, tokenYInfo] = await Promise.all([
      resolveMintProgram(connection, tokenX),
      resolveMintProgram(connection, tokenY),
    ]);
    assertSupported("tokenX", tokenXInfo);
    assertSupported("tokenY", tokenYInfo);
    assertNoTransferHookYet("tokenX", tokenXInfo);
    assertNoTransferHookYet("tokenY", tokenYInfo);
    const tokenXProgram = tokenXInfo.programId;
    const tokenYProgram = tokenYInfo.programId;

    const plan = planSingleSidedSol({
      totalLamports: args.totalSolLamports,
      activeBinId: args.config.activeBin,
      lowerBinId: args.config.lowerBinId,
      upperBinId: args.config.upperBinId,
      shape: args.shape,
      solIsTokenX,
    });

    const positionPubkey = await this.fetchPositionFromAuthority(positionAuthority);
    const [reserveX] = deriveReserve(tokenX, lbPair, dlmm.programId);
    const [reserveY] = deriveReserve(tokenY, lbPair, dlmm.programId);

    // PDA-owned escrow ATAs. Both must exist for DLMM CPI even when one
    // side is empty. Issued idempotently so a re-run after a confirmed
    // first attempt doesn't blow up. ATA derivation + create must pass
    // the per-mint token program ID — Token-2022 ATAs live under a
    // different derivation than legacy.
    const pdaAtaX = getAssociatedTokenAddressSync(
      tokenX, positionAuthority, true, tokenXProgram,
    );
    const pdaAtaY = getAssociatedTokenAddressSync(
      tokenY, positionAuthority, true, tokenYProgram,
    );
    const createPdaAtaXIx = createAssociatedTokenAccountIdempotentInstruction(
      relayer.publicKey, pdaAtaX, positionAuthority, tokenX, tokenXProgram,
    );
    const createPdaAtaYIx = createAssociatedTokenAccountIdempotentInstruction(
      relayer.publicKey, pdaAtaY, positionAuthority, tokenY, tokenYProgram,
    );

    // Wrap stealth's SOL through a stealth-owned WSOL ATA before transferring
    // to the PDA. Routing through a stealth ATA keeps the stealth's signature
    // visible on the wrap and lets us close the temp ATA at the end so rent
    // comes back to the stealth.
    const stealthWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, args.stealth);
    const createStealthWsolAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      relayer.publicKey, stealthWsolAta, args.stealth, NATIVE_MINT,
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

    // v2 layout (add_liquidity_by_strategy2). Bin arrays drop out of the
    // fixed account list and move to the tail; transfer-hook accounts (when
    // we add them) sit between sender and bin arrays.
    const dlmmAccounts: AccountMeta[] = [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },         // 0 position
      { pubkey: lbPair, isSigner: false, isWritable: true },                 // 1 lb_pair
      { pubkey: dlmm.programId, isSigner: false, isWritable: false },        // 2 bitmap_ext = None (sentinel)
      { pubkey: pdaAtaX, isSigner: false, isWritable: true },                // 3 user_token_x
      { pubkey: pdaAtaY, isSigner: false, isWritable: true },                // 4 user_token_y
      { pubkey: reserveX, isSigner: false, isWritable: true },               // 5 reserve_x
      { pubkey: reserveY, isSigner: false, isWritable: true },               // 6 reserve_y
      { pubkey: tokenX, isSigner: false, isWritable: false },                // 7 token_x_mint
      { pubkey: tokenY, isSigner: false, isWritable: false },                // 8 token_y_mint
      { pubkey: positionAuthority, isSigner: false, isWritable: false },     // 9 sender (re-pinned to PA on-chain)
      { pubkey: tokenXProgram, isSigner: false, isWritable: false },         // 10 token_x_program
      { pubkey: tokenYProgram, isSigner: false, isWritable: false },         // 11 token_y_program
      { pubkey: dlmm.eventAuthority, isSigner: false, isWritable: false },   // 12 event_authority
      { pubkey: dlmm.programId, isSigner: false, isWritable: false },        // 13 program
      // tail: bin arrays. Transfer-hook accounts go before them when added.
      { pubkey: binArrayLower, isSigner: false, isWritable: true },          // 14 bin_array_lower
      { pubkey: binArrayUpper, isSigner: false, isWritable: true },          // 15 bin_array_upper
    ];

    // v2 payload = LiquidityParameterByStrategy bytes + RemainingAccountsInfo bytes.
    // For non-hooked mints the RemainingAccountsInfo is just an empty Vec.
    const v2Payload = Buffer.concat([
      Buffer.from(liquidityParams),
      EMPTY_REMAINING_ACCOUNTS_INFO,
    ]);

    const addLiqIx = await program.methods
      .dlmmAddLiquidity(v2Payload)
      .accounts({
        stealth: args.stealth,
        poolAuthority: positionAuthority,
        dlmmProgram: dlmm.programId,
        lbPair,
      })
      .remainingAccounts(dlmmAccounts)
      .instruction();

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: relayer.publicKey });
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
    tx.partialSign(relayer);

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
    const { connection, relayer, program, executorProgramId, dlmm } = this.ctx;
    const tokenX = new PublicKey(args.config.tokenX);
    const tokenY = new PublicKey(args.config.tokenY);
    const lbPair = new PublicKey(args.config.lbPair);
    const binArrayLower = new PublicKey(args.config.binArrayLower);
    const binArrayUpper = new PublicKey(args.config.binArrayUpper);
    const [positionAuthority] = derivePoolAuthorityPda(executorProgramId, args.stealth, lbPair);

    const acct = await (program.account as any).poolAuthority.fetch(positionAuthority);
    const exitRecipient = acct.exitRecipient as PublicKey;
    const positionPubkey = await this.fetchPositionFromAuthority(positionAuthority);
    const [reserveX] = deriveReserve(tokenX, lbPair, dlmm.programId);
    const [reserveY] = deriveReserve(tokenY, lbPair, dlmm.programId);

    const [tokenXInfo, tokenYInfo] = await Promise.all([
      resolveMintProgram(connection, tokenX),
      resolveMintProgram(connection, tokenY),
    ]);
    assertSupported("tokenX", tokenXInfo);
    assertSupported("tokenY", tokenYInfo);
    assertNoTransferHookYet("tokenX", tokenXInfo);
    assertNoTransferHookYet("tokenY", tokenYInfo);
    const tokenXProgram = tokenXInfo.programId;
    const tokenYProgram = tokenYInfo.programId;

    // exit_recipient ATAs (idempotent create paid by relayer fee payer).
    const exitAtaX = getAssociatedTokenAddressSync(
      tokenX, exitRecipient, false, tokenXProgram,
    );
    const exitAtaY = getAssociatedTokenAddressSync(
      tokenY, exitRecipient, false, tokenYProgram,
    );
    const createExitAtaXIx = createAssociatedTokenAccountIdempotentInstruction(
      relayer.publicKey, exitAtaX, exitRecipient, tokenX, tokenXProgram,
    );
    const createExitAtaYIx = createAssociatedTokenAccountIdempotentInstruction(
      relayer.publicKey, exitAtaY, exitRecipient, tokenY, tokenYProgram,
    );

    // v2 layout (claim_fee2). Bin range is now a required argument;
    // pull it from the position's stored range (lowerBinId..upperBinId).
    const dlmmAccounts: AccountMeta[] = [
      { pubkey: lbPair, isSigner: false, isWritable: true },                 // 0 lb_pair
      { pubkey: positionPubkey, isSigner: false, isWritable: true },         // 1 position
      { pubkey: positionAuthority, isSigner: false, isWritable: false },     // 2 sender (re-pinned to PA on-chain)
      { pubkey: reserveX, isSigner: false, isWritable: true },               // 3 reserve_x
      { pubkey: reserveY, isSigner: false, isWritable: true },               // 4 reserve_y
      { pubkey: exitAtaX, isSigner: false, isWritable: true },               // 5 user_token_x (exit_recipient)
      { pubkey: exitAtaY, isSigner: false, isWritable: true },               // 6 user_token_y (exit_recipient)
      { pubkey: tokenX, isSigner: false, isWritable: false },                // 7 token_x_mint
      { pubkey: tokenY, isSigner: false, isWritable: false },                // 8 token_y_mint
      { pubkey: tokenXProgram, isSigner: false, isWritable: false },         // 9 token_program_x
      { pubkey: tokenYProgram, isSigner: false, isWritable: false },         // 10 token_program_y
      { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },       // 11 memo_program
      { pubkey: dlmm.eventAuthority, isSigner: false, isWritable: false },   // 12 event_authority
      { pubkey: dlmm.programId, isSigner: false, isWritable: false },        // 13 dlmm_program
      // tail: transfer-hook accounts + bin arrays.
      { pubkey: binArrayLower, isSigner: false, isWritable: true },
      { pubkey: binArrayUpper, isSigner: false, isWritable: true },
    ];

    const ix = await program.methods
      .dlmmClaimFees(
        args.config.lowerBinId,
        args.config.upperBinId,
        EMPTY_REMAINING_ACCOUNTS_INFO,
      )
      .accounts({
        stealth: args.stealth,
        poolAuthority: positionAuthority,
        lbPair,
        dlmmProgram: dlmm.programId,
      })
      .remainingAccounts(dlmmAccounts)
      .instruction();

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: relayer.publicKey });
    tx.add(computeIx, createExitAtaXIx, createExitAtaYIx, ix);
    tx.partialSign(relayer);

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
    const { connection, relayer, program, executorProgramId, dlmm } = this.ctx;
    const tokenX = new PublicKey(args.config.tokenX);
    const tokenY = new PublicKey(args.config.tokenY);
    const lbPair = new PublicKey(args.config.lbPair);
    const binArrayLower = new PublicKey(args.config.binArrayLower);
    const binArrayUpper = new PublicKey(args.config.binArrayUpper);
    const [positionAuthority] = derivePoolAuthorityPda(executorProgramId, args.stealth, lbPair);

    const acct = await (program.account as any).poolAuthority.fetch(positionAuthority);
    const exitRecipient = acct.exitRecipient as PublicKey;

    const [tokenXInfo, tokenYInfo] = await Promise.all([
      resolveMintProgram(connection, tokenX),
      resolveMintProgram(connection, tokenY),
    ]);
    assertSupported("tokenX", tokenXInfo);
    assertSupported("tokenY", tokenYInfo);
    assertNoTransferHookYet("tokenX", tokenXInfo);
    assertNoTransferHookYet("tokenY", tokenYInfo);
    const tokenXProgram = tokenXInfo.programId;
    const tokenYProgram = tokenYInfo.programId;

    const exitAtaX = getAssociatedTokenAddressSync(
      tokenX, exitRecipient, false, tokenXProgram,
    );
    const exitAtaY = getAssociatedTokenAddressSync(
      tokenY, exitRecipient, false, tokenYProgram,
    );
    const createExitAtaXIx = createAssociatedTokenAccountIdempotentInstruction(
      relayer.publicKey, exitAtaX, exitRecipient, tokenX, tokenXProgram,
    );
    const createExitAtaYIx = createAssociatedTokenAccountIdempotentInstruction(
      relayer.publicKey, exitAtaY, exitRecipient, tokenY, tokenYProgram,
    );

    const positionPubkey = await this.fetchPositionFromAuthority(positionAuthority);
    const [reserveX] = deriveReserve(tokenX, lbPair, dlmm.programId);
    const [reserveY] = deriveReserve(tokenY, lbPair, dlmm.programId);
    // v2 layout (remove_liquidity_by_range2 + close_position2):
    // 0..14 = v2 remove_liquidity_by_range2 fixed slots; 15 =
    // rent_receiver (read by close_position2); tail = hook accounts +
    // bin arrays.
    const dlmmAccounts: AccountMeta[] = [
      { pubkey: positionPubkey, isSigner: false, isWritable: true },         // 0 position
      { pubkey: lbPair, isSigner: false, isWritable: true },                 // 1 lb_pair
      { pubkey: dlmm.programId, isSigner: false, isWritable: false },        // 2 bitmap_ext = None (sentinel)
      { pubkey: exitAtaX, isSigner: false, isWritable: true },               // 3 user_token_x (exit_recipient)
      { pubkey: exitAtaY, isSigner: false, isWritable: true },               // 4 user_token_y (exit_recipient)
      { pubkey: reserveX, isSigner: false, isWritable: true },               // 5 reserve_x
      { pubkey: reserveY, isSigner: false, isWritable: true },               // 6 reserve_y
      { pubkey: tokenX, isSigner: false, isWritable: false },                // 7 token_x_mint
      { pubkey: tokenY, isSigner: false, isWritable: false },                // 8 token_y_mint
      { pubkey: positionAuthority, isSigner: false, isWritable: false },     // 9 sender (re-pinned to PA)
      { pubkey: tokenXProgram, isSigner: false, isWritable: false },         // 10 token_x_program
      { pubkey: tokenYProgram, isSigner: false, isWritable: false },         // 11 token_y_program
      { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },       // 12 memo_program
      { pubkey: dlmm.eventAuthority, isSigner: false, isWritable: false },   // 13 event_authority
      { pubkey: dlmm.programId, isSigner: false, isWritable: false },        // 14 program
      { pubkey: exitRecipient, isSigner: false, isWritable: true },          // 15 rent_receiver
      // tail: transfer-hook accounts + bin arrays.
      { pubkey: binArrayLower, isSigner: false, isWritable: true },
      { pubkey: binArrayUpper, isSigner: false, isWritable: true },
    ];

    const ix = await program.methods
      .dlmmWithdrawClose(
        args.config.lowerBinId,
        args.config.upperBinId,
        10000,
        EMPTY_REMAINING_ACCOUNTS_INFO,
      )
      .accounts({
        stealth: args.stealth,
        poolAuthority: positionAuthority,
        lbPair,
        dlmmProgram: dlmm.programId,
      })
      .remainingAccounts(dlmmAccounts)
      .instruction();

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: relayer.publicKey });
    tx.add(computeIx, createExitAtaXIx, createExitAtaYIx, ix);
    tx.partialSign(relayer);

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    return {
      transaction: serialized.toString("base64"),
      exitRecipient: exitRecipient.toBase58(),
    };
  }

  /** Internal: read the PoolAuthority PDA to recover the DLMM position pubkey. */
  private async fetchPositionFromAuthority(pda: PublicKey): Promise<PublicKey> {
    const acct = await (this.ctx.program.account as any).poolAuthority.fetch(pda);
    const dlmm = acct.poolRef?.dlmm;
    if (!dlmm) throw new Error("PoolAuthority is not a DLMM position.");
    return dlmm.position as PublicKey;
  }
}
