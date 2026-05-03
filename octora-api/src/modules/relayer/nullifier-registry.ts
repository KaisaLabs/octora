import { Connection, PublicKey } from "@solana/web3.js";
import { isNullifierSpentOnChain } from "./solana-client.js";

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

/**
 * On-chain backed nullifier registry.
 *
 * Uses an in-memory cache for fast lookups, with on-chain PDA existence
 * check as the source of truth when the cache misses.
 *
 * Flow:
 * 1. Check local cache first (fast, avoids RPC calls)
 * 2. On cache miss, check on-chain PDA existence
 * 3. If PDA exists on-chain but not in cache, update cache
 */
export class OnChainNullifierRegistry implements NullifierRegistry {
  private readonly cache = new Map<string, NullifierEntry>();

  constructor(
    private readonly connection: Connection,
    private readonly programId: PublicKey,
    private readonly mixerPoolKey: PublicKey,
  ) {}

  async isSpent(nullifierHash: string): Promise<boolean> {
    // Fast path: check local cache
    if (this.cache.has(nullifierHash)) {
      return true;
    }

    // Slow path: check on-chain PDA existence
    const spentOnChain = await isNullifierSpentOnChain(
      this.connection,
      this.programId,
      this.mixerPoolKey,
      nullifierHash,
    );

    // Update cache if found on-chain
    if (spentOnChain) {
      this.cache.set(nullifierHash, {
        nullifierHash,
        txSignature: "on-chain",
        spentAt: Date.now(),
      });
    }

    return spentOnChain;
  }

  async markSpent(nullifierHash: string, txSignature: string): Promise<void> {
    this.cache.set(nullifierHash, {
      nullifierHash,
      txSignature,
      spentAt: Date.now(),
    });
  }

  async count(): Promise<number> {
    return this.cache.size;
  }
}
