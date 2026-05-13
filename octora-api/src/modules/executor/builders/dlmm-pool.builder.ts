import { BN } from "@coral-xyz/anchor";
import { PublicKey, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, createMint } from "@solana/spl-token";
import DLMM, {
  binIdToBinArrayIndex,
  deriveBinArray,
  deriveLbPair2,
} from "@meteora-ag/dlmm";

import type { BuilderContext, TestPairConfig } from "./types.js";

const ACTIVE_BIN = 0;

/**
 * Pool setup helpers used by the integrated test page.
 *
 * `setupTestPair` creates fresh SPL mints + a brand-new DLMM LB pair on a
 * known parameter preset. `useExistingPool` adopts a discovered pool (e.g.
 * via the Meteora devnet API) and initialises the bin arrays our position
 * range will straddle.
 */
export class DlmmPoolBuilder {
  constructor(private ctx: BuilderContext) {}

  /**
   * One-shot test setup: two SPL mints (relayer is mint authority), one DLMM
   * LB pair with `(binStep, baseFactor, activeBin=0)` from config, and the
   * two bin arrays our default `[-10..9]` position straddles.
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
     * which only supports SOL-paired pools.
     */
    useNativeSol?: boolean;
  } = {}): Promise<TestPairConfig> {
    const { connection, relayer, provider, dlmm } = this.ctx;
    const lowerBinId = opts.lowerBinId ?? -10;
    const width = opts.width ?? 20;
    const upperBinId = lowerBinId + width - 1;

    let tokenX: PublicKey;
    let tokenY: PublicKey;
    if (opts.useNativeSol) {
      tokenX = await createMint(connection, relayer, relayer.publicKey, null, 6);
      tokenY = NATIVE_MINT;
    } else {
      tokenX = await createMint(connection, relayer, relayer.publicKey, null, 6);
      tokenY = await createMint(connection, relayer, relayer.publicKey, null, 6);
    }
    // DLMM derives the LB pair PDA from the smaller-pubkey-first ordering of
    // the two mints. Match it locally so `deriveLbPair2` produces the same
    // address the SDK passes into createLbPair.
    if (Buffer.compare(tokenX.toBuffer(), tokenY.toBuffer()) > 0) {
      [tokenX, tokenY] = [tokenY, tokenX];
    }

    const createPairTx = await DLMM.createLbPair(
      connection,
      relayer.publicKey,
      tokenX,
      tokenY,
      new BN(dlmm.binStep),
      new BN(dlmm.baseFactor),
      dlmm.presetParameter,
      new BN(ACTIVE_BIN),
    );
    await provider.sendAndConfirm(createPairTx, [relayer]);

    const [lbPair] = deriveLbPair2(
      tokenX,
      tokenY,
      new BN(dlmm.binStep),
      new BN(dlmm.baseFactor),
      dlmm.programId,
    );

    const dlmmInstance = await DLMM.create(connection, lbPair);

    const lowerArrayIdx = binIdToBinArrayIndex(new BN(lowerBinId));
    const upperArrayIdx = binIdToBinArrayIndex(new BN(upperBinId));
    const uniqueArrayIdxs =
      lowerArrayIdx.eq(upperArrayIdx) ? [lowerArrayIdx] : [lowerArrayIdx, upperArrayIdx];

    const binArrayIxs = await dlmmInstance.initializeBinArrays(uniqueArrayIdxs, relayer.publicKey);
    if (binArrayIxs.length > 0) {
      await provider.sendAndConfirm(
        new Transaction().add(...binArrayIxs),
        [relayer],
      );
    }

    const [binArrayLower] = deriveBinArray(lbPair, lowerArrayIdx, dlmm.programId);
    const [binArrayUpper] = deriveBinArray(lbPair, upperArrayIdx, dlmm.programId);

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
      binStep: dlmm.binStep,
      baseFactor: dlmm.baseFactor,
    };
  }

  /**
   * Use an EXISTING LB pair (typically discovered via the Meteora devnet
   * API). Reads on-chain state for tokenX/Y, picks a position range around
   * the pool's current `activeId`, and initialises the two bin arrays our
   * position will straddle if they don't already exist.
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
     * pool's active bin. The deposit UX passes a user-selected lower bin
     * from the BinLiquidityChart.
     */
    lowerBinId?: number;
  }): Promise<TestPairConfig> {
    const { connection, relayer, provider, dlmm } = this.ctx;
    const width = args.width ?? 20;
    const dlmmInstance = await DLMM.create(connection, args.lbPair);

    const tokenX = dlmmInstance.lbPair.tokenXMint;
    const tokenY = dlmmInstance.lbPair.tokenYMint;
    const activeBin = dlmmInstance.lbPair.activeId;
    const binStep = dlmmInstance.lbPair.binStep;

    let lowerBinId = args.lowerBinId ?? activeBin - Math.floor(width / 2);
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
        lowerBinId = lowerArrayIdx.toNumber() * 70 - 1;
        if (upperBinId - lowerBinId + 1 > MAX_WIDTH) {
          upperBinId = lowerBinId + MAX_WIDTH - 1;
        }
        lowerArrayIdx = binIdToBinArrayIndex(new BN(lowerBinId));
        upperArrayIdx = binIdToBinArrayIndex(new BN(upperBinId));
      } else if (aboveActive) {
        upperBinId = upperArrayIdx.add(new BN(1)).toNumber() * 70;
        if (upperBinId - lowerBinId + 1 > MAX_WIDTH) {
          lowerBinId = upperBinId - MAX_WIDTH + 1;
        }
        lowerArrayIdx = binIdToBinArrayIndex(new BN(lowerBinId));
        upperArrayIdx = binIdToBinArrayIndex(new BN(upperBinId));
      } else {
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

    const binArrayIxs = await dlmmInstance.initializeBinArrays(uniqueArrayIdxs, relayer.publicKey);
    if (binArrayIxs.length > 0) {
      await provider.sendAndConfirm(
        new Transaction().add(...binArrayIxs),
        [relayer],
      );
    }

    const [binArrayLower] = deriveBinArray(args.lbPair, lowerArrayIdx, dlmm.programId);
    const [binArrayUpper] = deriveBinArray(args.lbPair, upperArrayIdx, dlmm.programId);

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
}
