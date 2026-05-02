import { generateCommitment, createVaultMerkleTree, type VaultMerkleTree, type Commitment } from "#modules/vault";
import type { DepositRecord } from "./types.js";

/**
 * Deposit Service — manages the deposit side of the mixer.
 *
 * Responsibilities:
 * - Generate commitments for new deposits
 * - Maintain the Merkle tree state (in-memory, synced from on-chain)
 * - Track deposit records for proof generation
 *
 * Flow: User calls deposit on-chain → event indexed → tree updated here.
 */
export class DepositService {
  private tree: VaultMerkleTree | null = null;
  private deposits: DepositRecord[] = [];

  /** Initialize the Merkle tree (call once on startup, optionally with existing leaves). */
  async initialize(existingCommitments: bigint[] = []): Promise<void> {
    this.tree = await createVaultMerkleTree(20, existingCommitments);
    this.deposits = existingCommitments.map((c, i) => ({
      commitment: c.toString(),
      leafIndex: i,
      blockTime: 0,
      txSignature: "historical",
    }));
  }

  /** Generate a fresh commitment for a new deposit. */
  async createCommitment(): Promise<Commitment> {
    return generateCommitment();
  }

  /**
   * Record a deposit after it's confirmed on-chain.
   * Inserts the commitment into the local Merkle tree.
   */
  recordDeposit(commitment: bigint, txSignature: string, blockTime: number): number {
    this.ensureInitialized();

    const leafIndex = this.tree!.insert(commitment);
    this.deposits.push({
      commitment: commitment.toString(),
      leafIndex,
      blockTime,
      txSignature,
    });

    return leafIndex;
  }

  /** Get the current Merkle root. */
  currentRoot(): string {
    this.ensureInitialized();
    return this.tree!.root().toString();
  }

  /** Get the Merkle tree instance (for proof generation). */
  getTree(): VaultMerkleTree {
    this.ensureInitialized();
    return this.tree!;
  }

  /** Get all deposit records. */
  getDeposits(): DepositRecord[] {
    return [...this.deposits];
  }

  /** Get deposit count. */
  depositCount(): number {
    return this.deposits.length;
  }

  /** Find the leaf index for a given commitment. */
  findCommitment(commitment: bigint): number {
    this.ensureInitialized();
    return this.tree!.indexOf(commitment);
  }

  private ensureInitialized(): asserts this is { tree: VaultMerkleTree } {
    if (!this.tree) {
      throw new Error("DepositService not initialized. Call initialize() first.");
    }
  }
}
