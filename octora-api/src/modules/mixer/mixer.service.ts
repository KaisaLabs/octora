import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  type ConfirmedSignatureInfo,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDL_PATH = join(__dirname, "..", "relayer", "idl", "octora_mixer.json");

const MIXER_POOL_SEED = Buffer.from("mixer_pool");
const COMMITMENT_SEED = Buffer.from("commitment");
const NULLIFIER_SEED = Buffer.from("nullifier");

export interface MixerServiceConfig {
  rpcUrl: string;
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

  constructor(config: MixerServiceConfig) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
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
    const provider = new AnchorProvider(this.connection, wallet, { commitment: "confirmed" });
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

    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
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
  } = {}): Promise<{ scannedSignatures: number; depositsLoaded: number }> {
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
      return { scannedSignatures: 0, depositsLoaded: 0 };
    }
    const depositDiscriminator = Buffer.from(depositEventEntry.discriminator);

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

        // Layout: 8-byte discriminator || 32-byte commitment || 4-byte leaf_index (LE) || 8-byte timestamp (LE)
        if (payload.length < 8 + 32 + 4) continue;
        if (!payload.subarray(0, 8).equals(depositDiscriminator)) continue;
        discriminatorMatches++;

        const commitmentBuf = payload.subarray(8, 40);
        const commitment = BigInt("0x" + commitmentBuf.toString("hex"));
        const leafIndex = payload.readUInt32LE(40);

        const key = commitment.toString();
        if (!this.deposits.has(key)) {
          this.deposits.set(key, { commitment: key, leafIndex, txSignature: sig.signature });
          depositsLoaded++;
        }
      }
    }

    log(
      `hydrateFromChain: scanned=${signatures.length} programDataLines=${programDataLines} ` +
        `discriminatorMatches=${discriminatorMatches} depositsLoaded=${depositsLoaded} ` +
        `cacheSize=${this.deposits.size} pool=${this.poolPDA.toBase58()}`,
    );

    return { scannedSignatures: signatures.length, depositsLoaded };
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

    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
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
      const accountInfo = await this.connection.getAccountInfo(this.poolPDA);
      if (!accountInfo) return null;

      const balance = await this.connection.getBalance(this.poolPDA);

      // Layout: discriminator(8) + authority(32) + denomination(8) +
      //         next_leaf_index(4) + current_root_index(1) + root_history(32*30) +
      //         is_paused(1) + bump(1)
      const data = accountInfo.data;
      const nextLeafIndex = data.readUInt32LE(8 + 32 + 8);
      const isPaused = data[8 + 32 + 8 + 4 + 1 + 32 * 30] === 1;

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

    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
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
    const acct = await this.connection.getAccountInfo(this.poolPDA);
    if (!acct) throw new MixerPoolNotInitializedError(this.denomination, this.poolPDA.toBase58());
  }
}

export class MixerPoolNotInitializedError extends Error {
  constructor(public readonly denomination: bigint, public readonly poolAddress: string) {
    super(
      `Mixer pool for denomination ${denomination.toString()} (${poolAddress}) not initialized. ` +
        `Run POST /mixer/initialize once with the admin authority before depositing.`,
    );
    this.name = "MixerPoolNotInitializedError";
  }
}

/**
 * Pack a bigint into exactly 32 big-endian bytes. Throws SeedRangeError if
 * the value doesn't fit, instead of letting Solana's findProgramAddressSync
 * surface a cryptic "Max seed length exceeded" 500 deeper in the stack.
 */
export class SeedRangeError extends Error {
  constructor(public readonly field: string, public readonly value: bigint) {
    super(`${field} value too large to fit in 32-byte PDA seed: ${value.toString()}`);
    this.name = "SeedRangeError";
  }
}

export function bigintToBytes32(value: bigint, field: string): Buffer {
  if (value < 0n || value >= 1n << 256n) {
    throw new SeedRangeError(field, value);
  }
  const out = Buffer.alloc(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
