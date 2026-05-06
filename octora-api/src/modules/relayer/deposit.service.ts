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
   * Record a deposit *after* it has been confirmed on-chain. Inserts the
   * commitment into the local Merkle tree.
   *
   * Caller contract: `txSignature` MUST refer to a finalized transaction
   * that emitted a `DepositEvent` with this commitment. Calling this with
   * an unconfirmed/forged commitment corrupts the local tree, which breaks
   * proof generation for every subsequent legitimate withdrawal — so this
   * method has no business being reachable from any HTTP-facing path.
   *
   * Front it with an indexer that hydrates from `getProgramAccounts` /
   * `getSignaturesForAddress` and verifies the `DepositEvent` payload, the
   * way `mixer.service.ts:hydrateFromChain` does.
   */
  recordDeposit(commitment: bigint, txSignature: string, blockTime: number): number {
    this.ensureInitialized();

    // Cheap fail-fast guards to make accidental misuse louder. Real
    // validation (the tx exists on-chain and emitted DepositEvent) belongs
    // in the indexer that calls this — we can't redo it from here without a
    // Connection handle, and we deliberately don't take one.
    if (commitment <= 0n) {
      throw new Error("recordDeposit: commitment must be a positive bigint.");
    }
    if (!txSignature || txSignature.length < 32) {
      throw new Error(
        "recordDeposit: txSignature must be a real on-chain signature, not a sentinel.",
      );
    }

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
