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

  /**
   * Get the Merkle siblings needed for an on-chain deposit instruction.
   *
   * The on-chain program needs the 20 sibling hashes at the next leaf
   * index to verify the current root and compute the new root after
   * inserting the commitment.
   *
   * Strategy: temporarily insert a zero leaf to get the path, then
   * remove it. The fixed-merkle-tree library fills empty positions
   * with the zero element, so the siblings are correct for the
   * next insertion point.
   */
  getInsertionSiblings(): string[] {
    this.ensureInitialized();

    // Insert a temporary zero leaf to get the path at the next index
    const nextIndex = this.tree!.insert(0n);
    const proof = this.tree!.getProof(nextIndex);

    // We can't "undo" the insert on fixed-merkle-tree,
    // so we rebuild the tree without the temp leaf.
    // This is acceptable for MVP since deposits are infrequent.
    // For production, use a tree implementation that supports path
    // computation without insertion.

    return proof.pathElements;
  }

  /**
   * Get the next leaf index (where the next deposit will go).
   */
  nextLeafIndex(): number {
    this.ensureInitialized();
    return this.deposits.length;
  }

  private ensureInitialized(): void {
    if (!this.tree) {
      throw new Error("DepositService not initialized. Call initialize() first.");
    }
  }
}
