import {
  type Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  type ConfirmedSignatureInfo,
} from "@solana/web3.js";
import { Program, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError, ConflictError } from "#common/errors";
import { loadConfig } from "#common/config";
import type { SolanaChain } from "#common/solana/chain";
import { bigintToBytes32, SeedRangeError } from "#common/solana/field-encoding";

// Re-export so the existing import paths (`#modules/mixer/mixer.service`)
// keep working. New callers should import directly from
// `#common/solana/field-encoding`.
export { bigintToBytes32, SeedRangeError };

import {
  MIXER_POOL_IS_PAUSED_OFFSET,
  MIXER_POOL_NEXT_LEAF_INDEX_OFFSET,
} from "./layout.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDL_PATH = join(__dirname, "..", "relayer", "idl", "octora_mixer.json");

const MIXER_POOL_SEED = Buffer.from("mixer_pool");
const COMMITMENT_SEED = Buffer.from("commitment");
const NULLIFIER_SEED = Buffer.from("nullifier");

/**
 * Minimum anonymity set required to permit a withdrawal build.
 *
 * The anonymity set is `next_leaf_index - withdrawals_so_far` — the count
 * of *unspent* deposits in the pool, which is the upper bound on how many
 * leaves a chain observer could plausibly link to any given withdrawal.
 *
 * Twenty is the smallest set where naive intersection attacks (overlap the
 * deposits set with a candidate stealth wallet's known link set) stop being
 * trivially decisive — Tornado Cash's empirical analysis showed sharp
 * de-anonymization risk under ~10 and acceptable mixing above ~20.
 *
 * Override via `MIXER_MIN_ANONYMITY_SET` env for staging/dev where you
 * need to test the withdraw path before twenty real deposits have landed.
 */
export const MIN_ANONYMITY_SET = loadConfig().mixer.minAnonymitySet;

/**
 * Thrown when a withdrawal build is rejected because the target pool has
 * fewer unspent deposits than `MIN_ANONYMITY_SET`. Surfaced by mixer +
 * relayer controllers as HTTP 400 `ANONYMITY_SET_TOO_THIN`.
 */
export class AnonymitySetTooThinError extends ApiError {
  // Keep HTTP 400 + literal `code` to match the legacy frontend contract.
  // The bespoke handlers in mixer.controller.ts / relayer.routes.ts still
  // map this to a route-specific body shape; the new global handler will
  // emit `{ error: { code, message, details } }` if those handlers are
  // ever removed.
  declare readonly code: "ANONYMITY_SET_TOO_THIN";
  constructor(
    readonly current: number,
    readonly required: number,
    readonly denomination: bigint,
  ) {
    super(
      400,
      "ANONYMITY_SET_TOO_THIN",
      `Anonymity set too thin: pool has ${current} unspent deposit(s), required ${required}.`,
      { details: { current, required, denomination: denomination.toString() } },
    );
    this.name = "AnonymitySetTooThinError";
  }
}

export interface MixerServiceConfig {
  chain: SolanaChain;
  denomination: bigint;
  programId: PublicKey;
}

export interface PublicDepositRecord {
  /** Decimal-string BN254 field element. */
  commitment: string;
  leafIndex: number;
  /** On-chain signature (or "pending" when only the build was requested). */
  txSignature: string;
}

interface BuildDepositArgs {
  depositorPubkey: string;
  commitment: bigint;
}

/**
 * Mixer Service — public-data orchestrator.
 *
 * This service intentionally does NOT generate commitments, stealth
 * wallets, or proofs. Anything that requires the user's secret material
 * runs in the browser (octora-web/src/lib/mixer/). The service only:
 *   - builds unsigned on-chain transactions
 *   - exposes the public deposit history for tree reconstruction
 *   - tracks which deposits the API has observed (best-effort cache)
 */
export class MixerService {
  private chain: SolanaChain;
  /**
   * Raw web3.js Connection — kept alongside `chain` because two paginated
   * RPC reads inside `hydrateFromChain` (`getSignaturesForAddress` and
   * `getTransaction`) are not on the `SolanaChain` interface. They're
   * cold-path operational reads (one shot per boot) and adding them
   * would widen the interface for a single caller. The Connection here
   * is always `chain.rawConnection()`; do not build a fresh one.
   */
  private connection: Connection;
  private denomination: bigint;
  private programId: PublicKey;
  private poolPDA: PublicKey;
  private program: Program;

  // In-memory mirror of the public deposit history. The on-chain DepositEvent
  // stream is the authoritative source; this cache is rehydrated on startup
  // by `hydrateFromChain()` and kept warm via `recordDeposit()` callbacks
  // from /mixer/confirm-deposit.
  private deposits = new Map<string, PublicDepositRecord>();

  // Spent-nullifier set tracked per-pool. We can't filter `getProgramAccounts`
  // by pool key (the NullifierAccount only stores a bump, not the pool seed),
  // so we count WithdrawEvent emissions on this pool's signatures during
  // hydration and rely on relayer/controller callbacks to keep the count warm
  // between scans. The set keys are decimal-string nullifier hashes; that
  // makes recordWithdrawal() idempotent so a re-scan can't double-count.
  private knownNullifiers = new Set<string>();

  constructor(config: MixerServiceConfig) {
    this.chain = config.chain;
    this.connection = this.chain.rawConnection();
    this.denomination = config.denomination;
    this.programId = config.programId;

    const denomBuf = Buffer.alloc(8);
    denomBuf.writeBigUInt64LE(config.denomination);
    [this.poolPDA] = PublicKey.findProgramAddressSync(
      [MIXER_POOL_SEED, denomBuf],
      this.programId,
    );

    // Read-only provider — we never sign on the server.
    const dummyKeypair = Keypair.generate();
    const wallet = new Wallet(dummyKeypair);
    const provider = this.chain.anchorProvider(wallet);
    const idl = JSON.parse(readFileSync(IDL_PATH, "utf-8"));
    idl.address = this.programId.toBase58();
    this.program = new Program(idl, provider);
  }

  /**
   * Build an unsigned deposit transaction.
   *
   * The new Merkle root is computed on-chain from the program's
   * filled_subtrees cache, so the browser doesn't need to (and can't)
   * supply one. The leaf index assigned to this deposit is whatever
   * `next_leaf_index` is when the tx lands — clients should read it
   * from the post-confirmation pool state or the emitted DepositEvent.
   *
   * The deposit performs 20 Poseidon syscalls during incremental
   * insertion, so we bump the compute budget on the tx.
   */
  async buildDepositTransaction(args: BuildDepositArgs): Promise<{ transaction: string }> {
    await this.assertPoolInitialized();
    const depositor = new PublicKey(args.depositorPubkey);
    const commitmentBytes = this.bigintToBytes32(args.commitment);

    const [commitmentPDA] = PublicKey.findProgramAddressSync(
      [COMMITMENT_SEED, this.poolPDA.toBuffer(), commitmentBytes],
      this.programId,
    );

    const ix = await this.program.methods
      .deposit(Array.from(commitmentBytes))
      .accounts({
        depositor,
        mixerPool: this.poolPDA,
        commitmentAccount: commitmentPDA,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

    const { blockhash } = await this.chain.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: depositor });
    tx.add(computeIx, ix);

    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return { transaction: serialized.toString("base64") };
  }

  /**
   * Record a confirmed deposit so future browser tree reconstructions
   * include it. Idempotent on commitment.
   */
  recordDeposit(commitment: bigint, leafIndex: number, txSignature: string): void {
    const key = commitment.toString();
    if (this.deposits.has(key)) return;
    this.deposits.set(key, { commitment: key, leafIndex, txSignature });
  }

  /** List public deposit history for browser tree reconstruction. */
  listDeposits(): PublicDepositRecord[] {
    return Array.from(this.deposits.values()).sort((a, b) => a.leafIndex - b.leafIndex);
  }

  /**
   * Rehydrate the deposit cache from on-chain DepositEvent logs.
   *
   * Walks signatures involving the pool PDA (paginated via getSignaturesForAddress),
   * fetches each transaction's log messages, and decodes Anchor's
   * `Program data: <base64>` lines via `program.coder.events.decode`. Any
   * DepositEvent found is upserted into the cache (idempotent on commitment).
   *
   * Best-effort: RPC failures on individual transactions are logged but
   * don't abort the scan, since /mixer/confirm-deposit can backfill any
   * gap when the next withdrawal / deposit happens. The cap on `maxPages`
   * (1000 signatures each) prevents an unbounded scan on a busy program.
   */
  async hydrateFromChain(opts: {
    maxPages?: number;
    log?: (msg: string) => void;
  } = {}): Promise<{
    scannedSignatures: number;
    depositsLoaded: number;
    withdrawalsLoaded: number;
  }> {
    const maxPages = opts.maxPages ?? 50; // up to 50_000 signatures
    const log = opts.log ?? (() => {});

    // Pull the DepositEvent discriminator straight out of the IDL so we
    // don't depend on Anchor's JS event coder, which has silently dropped
    // events on us when names normalize differently or the IDL drifts.
    // Discriminator is canonical (sha256("event:DepositEvent")[..8]) and
    // pinned in the IDL, so a byte-prefix match is the most reliable signal.
    const idl = this.program.idl as unknown as {
      events?: Array<{ name: string; discriminator: number[] }>;
    };
    const depositEventEntry = idl.events?.find(
      (e) => e.name === "DepositEvent" || e.name === "depositEvent",
    );
    if (!depositEventEntry) {
      log("hydrateFromChain: DepositEvent not found in IDL — cannot hydrate");
      return { scannedSignatures: 0, depositsLoaded: 0, withdrawalsLoaded: 0 };
    }
    const depositDiscriminator = Buffer.from(depositEventEntry.discriminator);

    // WithdrawEvent discriminator is optional — older IDLs predate the
    // anonymity-set gate. When missing we just skip the withdraw tally.
    const withdrawEventEntry = idl.events?.find(
      (e) => e.name === "WithdrawEvent" || e.name === "withdrawEvent",
    );
    const withdrawDiscriminator = withdrawEventEntry
      ? Buffer.from(withdrawEventEntry.discriminator)
      : null;

    const signatures: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      let batch: ConfirmedSignatureInfo[];
      try {
        batch = await this.connection.getSignaturesForAddress(
          this.poolPDA,
          { limit: 1000, before },
          "confirmed",
        );
      } catch (err) {
        log(
          `hydrateFromChain: getSignaturesForAddress failed on page ${page}: ${
            err instanceof Error ? err.message : "unknown"
          }`,
        );
        break;
      }
      if (batch.length === 0) break;
      signatures.push(...batch);
      if (batch.length < 1000) break;
      before = batch[batch.length - 1].signature;
    }

    // Process oldest-first so leaf indices land in chronological order.
    signatures.reverse();

    let programDataLines = 0;
    let discriminatorMatches = 0;
    let depositsLoaded = 0;
    let withdrawalsLoaded = 0;

    for (const sig of signatures) {
      if (sig.err) continue;
      let tx: Awaited<ReturnType<Connection["getTransaction"]>>;
      try {
        tx = await this.connection.getTransaction(sig.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      } catch (err) {
        log(
          `hydrateFromChain: getTransaction failed for ${sig.signature}: ${
            err instanceof Error ? err.message : "unknown"
          }`,
        );
        continue;
      }
      if (!tx?.meta?.logMessages) continue;

      for (const line of tx.meta.logMessages) {
        const m = line.match(/^Program data: (.+)$/);
        if (!m) continue;
        programDataLines++;

        let payload: Buffer;
        try {
          payload = Buffer.from(m[1], "base64");
        } catch {
          continue;
        }

        if (payload.length < 8 + 32) continue;
        const disc = payload.subarray(0, 8);

        // DepositEvent layout: 8-byte disc || 32-byte commitment || 4-byte leaf_index (LE) || 8-byte ts (LE)
        if (disc.equals(depositDiscriminator)) {
          if (payload.length < 8 + 32 + 4) continue;
          discriminatorMatches++;
          const commitmentBuf = payload.subarray(8, 40);
          const commitment = BigInt("0x" + commitmentBuf.toString("hex"));
          const leafIndex = payload.readUInt32LE(40);
          const key = commitment.toString();
          if (!this.deposits.has(key)) {
            this.deposits.set(key, { commitment: key, leafIndex, txSignature: sig.signature });
            depositsLoaded++;
          }
          continue;
        }

        // WithdrawEvent layout: 8-byte disc || 32-byte nullifier_hash || 32-byte recipient
        //                       || 32-byte relayer || 8-byte fee || 8-byte ts
        if (withdrawDiscriminator && disc.equals(withdrawDiscriminator)) {
          discriminatorMatches++;
          const nullifierBuf = payload.subarray(8, 40);
          const nullifier = BigInt("0x" + nullifierBuf.toString("hex")).toString();
          if (!this.knownNullifiers.has(nullifier)) {
            this.knownNullifiers.add(nullifier);
            withdrawalsLoaded++;
          }
          continue;
        }
      }
    }

    log(
      `hydrateFromChain: scanned=${signatures.length} programDataLines=${programDataLines} ` +
        `discriminatorMatches=${discriminatorMatches} depositsLoaded=${depositsLoaded} ` +
        `withdrawalsLoaded=${withdrawalsLoaded} cacheSize=${this.deposits.size} ` +
        `withdrawals=${this.knownNullifiers.size} pool=${this.poolPDA.toBase58()}`,
    );

    return { scannedSignatures: signatures.length, depositsLoaded, withdrawalsLoaded };
  }

  /**
   * Record a confirmed withdrawal so the anonymity-set snapshot reflects it
   * immediately, without waiting for the next on-chain re-scan. Called by
   * the relayer right after a successful `/relayer/withdraw`. Idempotent on
   * nullifier hash so a relayer-then-rescan can't double-count.
   */
  recordWithdrawal(nullifierHashDecimal: string): void {
    this.knownNullifiers.add(nullifierHashDecimal);
  }

  /**
   * Current anonymity-set snapshot. The "anonymity set" is the count of
   * unspent deposits — `nextLeafIndex` minus the number of nullifiers we
   * know to have been spent. Source of truth is in-memory state hydrated
   * at startup (`hydrateFromChain`) plus relayer callbacks; the floor
   * `max(0, …)` guards against an under-hydrated cache that overcounts
   * withdrawals.
   */
  async getAnonymitySetSnapshot(): Promise<{
    nextLeafIndex: number;
    withdrawalCount: number;
    anonymitySet: number;
  }> {
    const status = await this.getPoolStatus();
    const nextLeafIndex = status?.nextLeafIndex ?? 0;
    const withdrawalCount = this.knownNullifiers.size;
    const anonymitySet = Math.max(0, nextLeafIndex - withdrawalCount);
    return { nextLeafIndex, withdrawalCount, anonymitySet };
  }

  /**
   * Throws `AnonymitySetTooThinError` when the current pool has fewer than
   * `MIN_ANONYMITY_SET` unspent deposits. Called by `buildWithdrawTransaction`
   * and by the relayer before submitting on-chain.
   */
  async assertAnonymitySetSatisfied(): Promise<void> {
    if (MIN_ANONYMITY_SET <= 0) return;
    const snap = await this.getAnonymitySetSnapshot();
    if (snap.anonymitySet < MIN_ANONYMITY_SET) {
      throw new AnonymitySetTooThinError(
        snap.anonymitySet,
        MIN_ANONYMITY_SET,
        this.denomination,
      );
    }
  }

  /**
   * Build an unsigned withdrawal transaction. The proof + public inputs
   * arrive packed (base64) from the browser-side prover; we don't have
   * the witness inputs here and never see the secret/nullifier.
   */
  async buildWithdrawTransaction(
    signerPubkey: string,
    recipientPubkey: string,
    proofBytesBase64: string,
    publicInputsBytesBase64: string,
    nullifierHash: string,
  ): Promise<{ transaction: string }> {
    await this.assertPoolInitialized();
    await this.assertAnonymitySetSatisfied();
    const signer = new PublicKey(signerPubkey);
    const recipient = new PublicKey(recipientPubkey);
    const nullifierHashBuf = this.bigintToBytes32(BigInt(nullifierHash));

    const proofBytes = Buffer.from(proofBytesBase64, "base64");
    const publicInputsBytes = Buffer.from(publicInputsBytesBase64, "base64");

    const [nullifierPDA] = PublicKey.findProgramAddressSync(
      [NULLIFIER_SEED, this.poolPDA.toBuffer(), nullifierHashBuf],
      this.programId,
    );

    const ix = await this.program.methods
      .withdraw(Array.from(proofBytes), Array.from(publicInputsBytes))
      .accounts({
        signer,
        mixerPool: this.poolPDA,
        nullifierAccount: nullifierPDA,
        recipient,
        relayer: signer,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

    const { blockhash } = await this.chain.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: signer });
    tx.add(computeIx, ix);

    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return { transaction: serialized.toString("base64") };
  }

  /** Get pool status from on-chain. */
  async getPoolStatus(): Promise<{
    poolAddress: string;
    denomination: string;
    nextLeafIndex: number;
    isPaused: boolean;
    balance: string;
    depositsTracked: number;
  } | null> {
    try {
      const accountInfo = await this.chain.getAccountInfo(this.poolPDA);
      if (!accountInfo) return null;

      const balance = await this.chain.getBalance(this.poolPDA);

      // Layout offsets are defined in ./layout.ts and must stay in lockstep
      // with programs/octora-mixer/src/state.rs::MixerPool.
      const data = accountInfo.data;
      const nextLeafIndex = data.readUInt32LE(MIXER_POOL_NEXT_LEAF_INDEX_OFFSET);
      const isPaused = data[MIXER_POOL_IS_PAUSED_OFFSET] === 1;

      return {
        poolAddress: this.poolPDA.toBase58(),
        denomination: this.denomination.toString(),
        nextLeafIndex,
        isPaused,
        balance: balance.toString(),
        depositsTracked: this.deposits.size,
      };
    } catch {
      return null;
    }
  }

  /**
   * Stateless read of any mixer pool's on-chain status, independent of which
   * denomination this service instance was constructed for.
   *
   * Used by `/mixer/pools` and other surfaces that need to enumerate all
   * configured pools before we have a full denom-aware service layer. Returns
   * `null` when the pool PDA isn't initialized on-chain, matching the contract
   * of `getPoolStatus`.
   *
   * Approximation: `anonymitySet` is currently returned as `depositCount`
   * (= `next_leaf_index`). The accurate value subtracts the count of spent
   * nullifier PDAs, but that requires a `getProgramAccounts` scan we do not
   * want to hot-path here. The lower-bound is what the UI surfaces as
   * "≥ N deposits", which is the conservative direction for an anonymity gate.
   */
  static async readPoolStatus(
    chain: SolanaChain,
    programId: PublicKey,
    denomination: bigint,
  ): Promise<{
    poolAddress: string;
    denomination: string;
    nextLeafIndex: number;
    depositCount: number;
    withdrawalCount: number;
    anonymitySet: number;
    isPaused: boolean;
    balance: string;
  } | null> {
    const denomBuf = Buffer.alloc(8);
    denomBuf.writeBigUInt64LE(denomination);
    const [poolPDA] = PublicKey.findProgramAddressSync(
      [MIXER_POOL_SEED, denomBuf],
      programId,
    );

    const accountInfo = await chain.getAccountInfo(poolPDA);
    if (!accountInfo) return null;

    const balance = await chain.getBalance(poolPDA);
    const data = accountInfo.data;
    const nextLeafIndex = data.readUInt32LE(MIXER_POOL_NEXT_LEAF_INDEX_OFFSET);
    const isPaused = data[MIXER_POOL_IS_PAUSED_OFFSET] === 1;

    return {
      poolAddress: poolPDA.toBase58(),
      denomination: denomination.toString(),
      nextLeafIndex,
      depositCount: nextLeafIndex,
      // Tracking withdrawal count requires either persistent state in the
      // relayer or a getProgramAccounts scan for nullifier PDAs. Both land
      // with the MIN_ANONYMITY_SET enforcement task; until then, treat 0 as
      // the lower-bound (over-estimates anonymity set, but only for pools
      // that have actually seen withdrawals — early-beta pools will be 0).
      withdrawalCount: 0,
      anonymitySet: nextLeafIndex,
      isPaused,
      balance: balance.toString(),
    };
  }

  /** Build an unsigned initialize transaction. */
  async buildInitializeTransaction(
    authorityPubkey: string,
  ): Promise<{ transaction: string; poolAddress: string }> {
    const authority = new PublicKey(authorityPubkey);

    const ix = await this.program.methods
      .initialize(new (await import("@coral-xyz/anchor")).BN(this.denomination.toString()))
      .accounts({
        authority,
        mixerPool: this.poolPDA,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const { blockhash } = await this.chain.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: authority });
    tx.add(ix);

    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return {
      transaction: serialized.toString("base64"),
      poolAddress: this.poolPDA.toBase58(),
    };
  }

  private bigintToBytes32(value: bigint): Buffer {
    return bigintToBytes32(value, "commitment");
  }

  /**
   * Throw a typed error if the on-chain mixer_pool account doesn't exist.
   *
   * Without this guard, Anchor's IDL-driven PDA verification (the
   * mixer_pool PDA seeds reference the account's own `denomination` field)
   * fails deep inside @coral-xyz/anchor with the cryptic
   * "Max seed length exceeded" — because the unresolved account body is
   * passed as a seed when the account doesn't exist.
   *
   * Surface a clear 400 instead so the caller knows to run
   * `POST /mixer/initialize` once for the configured denomination.
   */
  async assertPoolInitialized(): Promise<void> {
    const acct = await this.chain.getAccountInfo(this.poolPDA);
    if (!acct) throw new MixerPoolNotInitializedError(this.denomination, this.poolPDA.toBase58());
  }
}

export class MixerPoolNotInitializedError extends ConflictError {
  constructor(public readonly denomination: bigint, public readonly poolAddress: string) {
    super(
      `Mixer pool for denomination ${denomination.toString()} (${poolAddress}) not initialized. ` +
        `Run POST /mixer/initialize once with the admin authority before depositing.`,
      {
        code: "mixer_pool_not_initialized",
        details: { denomination: denomination.toString(), poolAddress },
      },
    );
    this.name = "MixerPoolNotInitializedError";
  }
}

// SeedRangeError + bigintToBytes32 moved to common/solana/field-encoding.ts;
// re-exported from the top of this file for back-compat with existing
// import paths.
