/**
 * Nullifier Registry — tracks spent nullifiers to prevent double-withdrawals.
 *
 * In production this backs to the on-chain program state,
 * but the relayer keeps a local cache for fast pre-checks.
 */
export interface NullifierRegistry {
  /** Check if a nullifier has already been spent. */
  isSpent(nullifierHash: string): Promise<boolean>;
  /** Mark a nullifier as spent after successful on-chain withdrawal. */
  markSpent(nullifierHash: string, txSignature: string): Promise<void>;
  /** Total number of spent nullifiers. */
  count(): Promise<number>;
}

interface NullifierEntry {
  nullifierHash: string;
  txSignature: string;
  spentAt: number;
}

/**
 * In-memory nullifier registry for MVP.
 * Replace with DB-backed implementation for production.
 */
export class InMemoryNullifierRegistry implements NullifierRegistry {
  private readonly spent = new Map<string, NullifierEntry>();

  async isSpent(nullifierHash: string): Promise<boolean> {
    return this.spent.has(nullifierHash);
  }

  async markSpent(nullifierHash: string, txSignature: string): Promise<void> {
    if (this.spent.has(nullifierHash)) {
      throw new Error(`Nullifier ${nullifierHash} already spent.`);
    }
    this.spent.set(nullifierHash, {
      nullifierHash,
      txSignature,
      spentAt: Date.now(),
    });
  }

  async count(): Promise<number> {
    return this.spent.size;
  }
}
