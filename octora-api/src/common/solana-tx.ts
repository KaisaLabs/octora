import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  MessageV0,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  type Commitment,
  type RecentPrioritizationFees,
} from "@solana/web3.js";

/**
 * Solana transaction submission helpers (P1-27, P1-28).
 *
 * Centralizes three behaviors that every relayer-side `sendAndConfirm`
 * must do correctly under mainnet load:
 *
 *   1. **Retry on retryable RPC failures.** `BlockhashNotFound`,
 *      `NodeUnhealthy`, and transient network errors are common under
 *      congestion; a single bare `.rpc()` call silently drops the
 *      transaction. We wrap the submit + confirm path in an
 *      exponential-backoff retry, fetching a fresh blockhash on every
 *      attempt so an expired hash never resurfaces.
 *
 *   2. **Profile compute units via `simulateTransaction`.** Hardcoding
 *      400_000 CU either over-pays priority fees or fails the simulator
 *      when the actual cost exceeds the hardcoded ceiling. We simulate
 *      once, take `unitsConsumed × 1.2`, and clamp to the 1.4M CU max.
 *
 *   3. **Pick a priority fee from `getRecentPrioritizationFees`.** A
 *      static (or zero) priority fee won't land during congestion. We
 *      sample the recent fee distribution across the writable accounts
 *      this tx touches, take the 75th percentile, and cap at the
 *      operator-supplied ceiling so a fee-griefing flood can't drain
 *      the relayer's hot wallet.
 *
 * Used by the mixer relayer's withdraw-submission path; export the
 * helper rather than the relayer's bespoke logic so the executor's
 * on-chain CPI client can reuse it later.
 */

const DEFAULT_MAX_ATTEMPTS = 3;
const SOLANA_MAX_CU = 1_400_000;
const CU_SAFETY_MULTIPLIER = 1.2;
/** Default ceiling on priority fee — 0.01 SOL on a 1.4M CU tx. */
const DEFAULT_MAX_PRIORITY_FEE_MICROLAMPORTS = 10_000_000n;
/** Floor — set when getRecentPrioritizationFees returns nothing. */
const DEFAULT_MIN_PRIORITY_FEE_MICROLAMPORTS = 1_000n;

export interface SubmitConfirmedOptions {
  connection: Connection;
  instructions: TransactionInstruction[];
  /** Signers in any order; the function dedupes against `payer`. */
  signers: Keypair[];
  payer: PublicKey;
  /** Hot accounts used to query recent priority fees (writable in the tx). */
  priorityFeeAccounts?: PublicKey[];
  /** Override the simulated CU estimate. 0 disables simulation. */
  computeUnitLimit?: number;
  /** Skip simulation entirely (faster, but uses Solana's default 200k CU). */
  skipSimulation?: boolean;
  /**
   * Hard ceiling on micro-lamports per CU. Defaults to 0.01 SOL on a
   * 1.4M CU tx; override per-route if your tx cost profile is unusual.
   */
  maxPriorityFeeMicroLamports?: bigint;
  /** Number of submission attempts before giving up. Default 3. */
  maxAttempts?: number;
  /** Commitment for confirm + simulate. Default "confirmed". */
  commitment?: Commitment;
  /**
   * Optional structured logger; called on each attempt + on retry decisions.
   * Production wiring passes `app.log.info.bind(app.log)`.
   */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

const RETRYABLE_PATTERNS = [
  /BlockhashNotFound/i,
  /Blockhash not found/i,
  /NodeUnhealthy/i,
  /node is behind/i,
  /unable to send transaction/i,
  /failed to fetch/i,
  /econnreset/i,
  /etimedout/i,
  /service unavailable/i,
];

/**
 * Submit instructions as a single confirmed transaction. Profiles CU,
 * picks priority fee, and retries on transient RPC failures with
 * exponential backoff.
 *
 * Returns the confirmed signature.
 */
export async function submitConfirmed(opts: SubmitConfirmedOptions): Promise<string> {
  const {
    connection,
    instructions,
    signers,
    payer,
    priorityFeeAccounts = [],
    skipSimulation = false,
    maxPriorityFeeMicroLamports = DEFAULT_MAX_PRIORITY_FEE_MICROLAMPORTS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    commitment = "confirmed",
    log = () => {},
  } = opts;

  // 1) Simulate once to estimate CU. The result is reused across retry
  //    attempts; only the blockhash/priority fee differ between attempts.
  let cuLimit = opts.computeUnitLimit ?? 400_000;
  if (!skipSimulation && opts.computeUnitLimit === undefined) {
    cuLimit = await estimateComputeUnits({
      connection,
      instructions,
      payer,
      signers,
      log,
    });
  }

  // 2) Sample recent priority fees on the touched accounts. Done once;
  //    repeated retries reuse the sample.
  const microLamportsPerCu = await pickPriorityFeeMicroLamports({
    connection,
    accounts: priorityFeeAccounts,
    cap: maxPriorityFeeMicroLamports,
    log,
  });

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);

      // Build the per-attempt instruction list with fresh CU + priority fee
      // ixs. They go *first* so they apply to the rest of the tx.
      const allIxs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(microLamportsPerCu) }),
        ...instructions,
      ];

      const message = MessageV0.compile({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions: allIxs,
      });
      const tx = new VersionedTransaction(message);

      // Sign with each unique keypair. Anchor passes signer Keypair[]
      // for the payer slot, so we de-dupe by base58.
      const seen = new Set<string>();
      const finalSigners: Keypair[] = [];
      for (const kp of signers) {
        const k = kp.publicKey.toBase58();
        if (seen.has(k)) continue;
        seen.add(k);
        finalSigners.push(kp);
      }
      tx.sign(finalSigners);

      log("solana-tx: submitting", {
        attempt,
        cuLimit,
        microLamportsPerCu: microLamportsPerCu.toString(),
        signers: finalSigners.length,
      });

      const signature = await connection.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 0,
      });

      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        commitment,
      );

      if (confirmation.value.err) {
        const errStr = JSON.stringify(confirmation.value.err);
        // confirm-time errors are NOT retryable here — they mean the program
        // rejected the tx (e.g. constraint violation). Bubble up so the
        // caller can decode/decorate.
        throw new Error(`Tx ${signature} failed on-chain: ${errStr}`);
      }

      log("solana-tx: confirmed", { attempt, signature });
      return signature;
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      const retryable = RETRYABLE_PATTERNS.some((p) => p.test(message));
      log("solana-tx: attempt failed", { attempt, retryable, error: message });

      if (!retryable || attempt === maxAttempts) {
        throw err;
      }
      // Exponential backoff: 250ms, 750ms, 2250ms ...
      const delayMs = 250 * 3 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  // Defensive: the loop always either returns or throws, but the linter
  // can't see it. Throw the last error to satisfy the control-flow analyzer.
  throw lastErr ?? new Error("submitConfirmed: exhausted retries with no recorded error");
}

interface EstimateOpts {
  connection: Connection;
  instructions: TransactionInstruction[];
  payer: PublicKey;
  signers: Keypair[];
  log: (msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * Run `simulateTransaction` once to learn how many CUs the tx actually
 * consumes, then pad by 20% so a slightly heavier execution path won't
 * blow the budget. Falls back to the static 400k default on simulator
 * failures (RPC down, simulator error) — better to over-pay priority
 * fees than to fail every submission because the simulator is flaky.
 */
export async function estimateComputeUnits(opts: EstimateOpts): Promise<number> {
  const { connection, instructions, payer, signers, log } = opts;
  try {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    // Set a high ceiling for the simulation so we observe actual usage,
    // not a clipped value. Solana's max CU per tx is 1.4M.
    const simIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: SOLANA_MAX_CU }),
      ...instructions,
    ];
    const message = MessageV0.compile({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions: simIxs,
    });
    const tx = new VersionedTransaction(message);
    tx.sign(signers);

    const sim = await connection.simulateTransaction(tx, { sigVerify: false });
    const used = sim.value.unitsConsumed ?? 0;
    if (used <= 0) {
      log("solana-tx: simulator reported 0 CUs, falling back to default", {});
      return 400_000;
    }
    const padded = Math.min(SOLANA_MAX_CU, Math.ceil(used * CU_SAFETY_MULTIPLIER));
    log("solana-tx: cu estimate", { used, padded });
    return padded;
  } catch (err) {
    log("solana-tx: simulate failed; using default 400k CU", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 400_000;
  }
}

interface PickFeeOpts {
  connection: Connection;
  accounts: PublicKey[];
  cap: bigint;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * Sample recent priority fees across the writable accounts this tx
 * touches and take the 75th percentile, capped at `cap`. The cap is
 * what stops a fee-griefing flood from draining the hot wallet — when
 * congestion spikes the cluster's prioritization fee can hit
 * micro-lamports-per-CU in the millions, which on a 1.4M CU tx is
 * thousands of dollars.
 */
export async function pickPriorityFeeMicroLamports(opts: PickFeeOpts): Promise<bigint> {
  const { connection, accounts, cap, log } = opts;
  try {
    let samples: RecentPrioritizationFees[] = [];
    if (accounts.length > 0) {
      samples = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: accounts });
    } else {
      samples = await connection.getRecentPrioritizationFees();
    }
    if (samples.length === 0) {
      return DEFAULT_MIN_PRIORITY_FEE_MICROLAMPORTS;
    }
    const sorted = samples
      .map((s) => s.prioritizationFee)
      .sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.75) - 1);
    const p75 = BigInt(Math.max(0, sorted[idx] ?? 0));
    const capped = p75 > cap ? cap : p75 < DEFAULT_MIN_PRIORITY_FEE_MICROLAMPORTS
      ? DEFAULT_MIN_PRIORITY_FEE_MICROLAMPORTS
      : p75;
    log("solana-tx: priority fee", {
      samples: samples.length,
      p75: p75.toString(),
      capped: capped.toString(),
      cap: cap.toString(),
    });
    return capped;
  } catch (err) {
    log("solana-tx: priority fee fetch failed; using floor", {
      error: err instanceof Error ? err.message : String(err),
    });
    return DEFAULT_MIN_PRIORITY_FEE_MICROLAMPORTS;
  }
}
