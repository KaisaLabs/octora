import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
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
  newRoot: bigint;
  leafIndex: number;
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

  // In-memory mirror of the public deposit history. Authoritative source is
  // the on-chain DepositEvent stream; this cache is best-effort and may be
  // stale if the API restarts. Future work: hydrate from on-chain events
  // on startup.
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
   * Build an unsigned deposit transaction. The browser supplies both the
   * commitment and the new merkle root computed against its local tree.
   */
  async buildDepositTransaction(args: BuildDepositArgs): Promise<{
    transaction: string;
    leafIndex: number;
  }> {
    const depositor = new PublicKey(args.depositorPubkey);
    const commitmentBytes = this.bigintToBytes32(args.commitment);
    const newRootBytes = Array.from(this.bigintToBytes32(args.newRoot));

    const [commitmentPDA] = PublicKey.findProgramAddressSync(
      [COMMITMENT_SEED, this.poolPDA.toBuffer(), commitmentBytes],
      PROGRAM_ID,
    );

    const ix = await this.program.methods
      .deposit(Array.from(commitmentBytes), newRootBytes)
      .accounts({
        depositor,
        mixerPool: this.poolPDA,
        commitmentAccount: commitmentPDA,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: depositor });
    tx.add(ix);

    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    return {
      transaction: serialized.toString("base64"),
      leafIndex: args.leafIndex,
    };
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
