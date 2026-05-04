import { Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateCommitment as genCommitment,
  generateProofInputs,
  type Commitment,
} from "#modules/vault";
import {
  createVaultMerkleTree,
  type VaultMerkleTree,
} from "#modules/vault";
import { generateWithdrawProof, verifyWithdrawProof } from "#modules/vault";
import { generateStealthWallet, type StealthWallet } from "#modules/relayer";
import { convertProofToBytes, convertPublicInputsToBytes, pubkeyToFieldElement } from "#modules/relayer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDL_PATH = join(__dirname, "..", "relayer", "idl", "octora_mixer.json");

const PROGRAM_ID = new PublicKey("Ao58tvHj3FTwFMiGts5HAc5mastNE61Puiw4ER3rA3NJ");
const MIXER_POOL_SEED = Buffer.from("mixer_pool");
const COMMITMENT_SEED = Buffer.from("commitment");
const NULLIFIER_SEED = Buffer.from("nullifier");
const TREE_LEVELS = 20;

export interface MixerServiceConfig {
  rpcUrl: string;
  denomination: bigint;
}

/**
 * Mixer Service — manages the full deposit → proof → withdraw lifecycle.
 *
 * This is the API-level orchestrator that ties together:
 * - Commitment generation (vault module)
 * - Merkle tree management (vault module)
 * - On-chain deposit transaction building
 * - ZK proof generation (snarkjs)
 * - Stealth wallet generation (relayer module)
 * - On-chain withdrawal (relayer service)
 */
export class MixerService {
  private connection: Connection;
  private tree: VaultMerkleTree | null = null;
  private deposits: { commitment: bigint; leafIndex: number }[] = [];
  private denomination: bigint;
  private poolPDA: PublicKey;
  private program: Program;

  constructor(config: MixerServiceConfig) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.denomination = config.denomination;

    const denomBuf = Buffer.alloc(8);
    denomBuf.writeBigUInt64LE(config.denomination);
    [this.poolPDA] = PublicKey.findProgramAddressSync(
      [MIXER_POOL_SEED, denomBuf],
      PROGRAM_ID,
    );

    // Create a read-only provider (no wallet needed for building unsigned txs)
    const dummyKeypair = Keypair.generate();
    const wallet = new Wallet(dummyKeypair);
    const provider = new AnchorProvider(this.connection, wallet, { commitment: "confirmed" });
    const idl = JSON.parse(readFileSync(IDL_PATH, "utf-8"));
    this.program = new Program(idl, provider);
  }

  async initialize(): Promise<void> {
    this.tree = await createVaultMerkleTree(TREE_LEVELS);
  }

  /** Generate a fresh commitment for deposit. */
  async generateCommitment(): Promise<Commitment> {
    return genCommitment();
  }

  /**
   * Build an unsigned deposit transaction.
   * The frontend will sign it with the user's wallet.
   */
  async buildDepositTransaction(
    depositorPubkey: string,
    commitment: bigint,
  ): Promise<{ transaction: string; newRoot: string; leafIndex: number }> {
    this.ensureInitialized();

    const depositor = new PublicKey(depositorPubkey);
    const commitmentBytes = this.bigintToBytes32(commitment);

    // Insert commitment into local tree and get new root
    const leafIndex = this.tree!.insert(commitment);
    const newRoot = this.tree!.root();
    const newRootBytes = Array.from(this.bigintToBytes32(newRoot));

    const [commitmentPDA] = PublicKey.findProgramAddressSync(
      [COMMITMENT_SEED, this.poolPDA.toBuffer(), commitmentBytes],
      PROGRAM_ID,
    );

    // Build the instruction
    const ix = await this.program.methods
      .deposit(Array.from(commitmentBytes), newRootBytes)
      .accounts({
        depositor,
        mixerPool: this.poolPDA,
        commitmentAccount: commitmentPDA,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // Build transaction
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: depositor,
    });
    tx.add(ix);

    // Serialize for frontend signing
    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    this.deposits.push({ commitment, leafIndex });

    return {
      transaction: serialized.toString("base64"),
      newRoot: newRoot.toString(),
      leafIndex,
    };
  }

  /**
   * Confirm a deposit after the user signed and sent the transaction.
   * Updates internal state tracking.
   */
  async confirmDeposit(commitment: bigint, txSignature: string): Promise<void> {
    // The tree was already updated in buildDepositTransaction
    // Just track the confirmation
    console.log(`Deposit confirmed: ${txSignature} for commitment ${commitment}`);
  }

  /** Generate a stealth wallet. */
  generateStealthWallet(): { publicKey: string; secretKey: string } {
    const wallet = generateStealthWallet();
    return {
      publicKey: wallet.publicKey,
      secretKey: Buffer.from(wallet.keypair.secretKey).toString("hex"),
    };
  }

  /**
   * Generate a ZK proof for withdrawal.
   * Returns the proof + public signals + packed bytes ready for on-chain submission.
   */
  async generateProof(
    secret: string,
    nullifier: string,
    leafIndex: number,
    recipientPubkey: string,
    relayerPubkey: string,
    fee: string,
  ): Promise<{
    proof: any;
    publicSignals: string[];
    proofBytes: string;
    publicInputsBytes: string;
  }> {
    this.ensureInitialized();

    const secretBigint = BigInt(secret);
    const nullifierBigint = BigInt(nullifier);
    const nullifierHash = (await import("#modules/vault")).poseidonHash([nullifierBigint]);
    const recipientField = pubkeyToFieldElement(new PublicKey(recipientPubkey));
    const relayerField = pubkeyToFieldElement(new PublicKey(relayerPubkey));

    const inputs = generateProofInputs(
      this.tree!,
      leafIndex,
      secretBigint,
      nullifierBigint,
      await nullifierHash,
      recipientField,
      relayerField,
      BigInt(fee),
    );

    const { proof, publicSignals } = await generateWithdrawProof(inputs);

    const proofBytes = convertProofToBytes(proof);
    const publicInputsBytes = convertPublicInputsToBytes(publicSignals);

    return {
      proof,
      publicSignals,
      proofBytes: proofBytes.toString("base64"),
      publicInputsBytes: publicInputsBytes.toString("base64"),
    };
  }

  /**
   * Build an unsigned withdrawal transaction.
   * The relayer (or user) will sign and submit it.
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
    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: signer,
    });
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

      // Parse pool data manually (skip 8-byte discriminator):
      // authority (32) + denomination (8) + next_leaf_index (4) + current_root_index (1) + ...
      const data = accountInfo.data;
      const nextLeafIndex = data.readUInt32LE(8 + 32 + 8); // offset: discriminator(8) + authority(32) + denomination(8)
      const isPaused = data[8 + 32 + 8 + 4 + 1 + 32 * 30] === 1; // after root_history

      return {
        poolAddress: this.poolPDA.toBase58(),
        denomination: this.denomination.toString(),
        nextLeafIndex,
        isPaused,
        balance: balance.toString(),
        depositsTracked: this.deposits.length,
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
    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: authority,
    });
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

  private ensureInitialized(): void {
    if (!this.tree) {
      throw new Error("MixerService not initialized. Call initialize() first.");
    }
  }
}
