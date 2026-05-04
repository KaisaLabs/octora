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

const PROGRAM_ID = new PublicKey("Ao58tvHj3FTwFMiGts5HAc5mastNE61Puiw4ER3rA3NJ");
const MIXER_POOL_SEED = Buffer.from("mixer_pool");
const COMMITMENT_SEED = Buffer.from("commitment");
const NULLIFIER_SEED = Buffer.from("nullifier");

export interface MixerServiceConfig {
  rpcUrl: string;
  denomination: bigint;
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

    const denomBuf = Buffer.alloc(8);
    denomBuf.writeBigUInt64LE(config.denomination);
    [this.poolPDA] = PublicKey.findProgramAddressSync(
      [MIXER_POOL_SEED, denomBuf],
      PROGRAM_ID,
    );

    // Read-only provider — we never sign on the server.
    const dummyKeypair = Keypair.generate();
    const wallet = new Wallet(dummyKeypair);
    const provider = new AnchorProvider(this.connection, wallet, { commitment: "confirmed" });
    const idl = JSON.parse(readFileSync(IDL_PATH, "utf-8"));
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
    const depositor = new PublicKey(args.depositorPubkey);
    const commitmentBytes = this.bigintToBytes32(args.commitment);

    const [commitmentPDA] = PublicKey.findProgramAddressSync(
      [COMMITMENT_SEED, this.poolPDA.toBuffer(), commitmentBytes],
      PROGRAM_ID,
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
        let decoded: { name: string; data: unknown } | null = null;
        try {
          decoded = this.program.coder.events.decode(m[1]) as
            | { name: string; data: unknown }
            | null;
        } catch {
          continue;
        }
        if (!decoded || decoded.name !== "DepositEvent") continue;

        // Anchor decodes [u8; 32] as number[]; rebuild as bigint to match
        // how recordDeposit stores keys.
        const data = decoded.data as {
          commitment: number[] | Uint8Array;
          leafIndex?: number;
          leaf_index?: number;
        };
        const commitmentBuf = Buffer.from(data.commitment as ArrayLike<number>);
        const commitment = BigInt("0x" + commitmentBuf.toString("hex"));
        const leafIndex = data.leafIndex ?? data.leaf_index ?? 0;

        const key = commitment.toString();
        if (!this.deposits.has(key)) {
          this.deposits.set(key, { commitment: key, leafIndex, txSignature: sig.signature });
          depositsLoaded++;
        }
      }
    }

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
    const signer = new PublicKey(signerPubkey);
    const recipient = new PublicKey(recipientPubkey);
    const nullifierHashBuf = this.bigintToBytes32(BigInt(nullifierHash));

    const proofBytes = Buffer.from(proofBytesBase64, "base64");
    const publicInputsBytes = Buffer.from(publicInputsBytesBase64, "base64");

    const [nullifierPDA] = PublicKey.findProgramAddressSync(
      [NULLIFIER_SEED, this.poolPDA.toBuffer(), nullifierHashBuf],
      PROGRAM_ID,
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
    const hex = value.toString(16).padStart(64, "0");
    return Buffer.from(hex, "hex");
  }
}
