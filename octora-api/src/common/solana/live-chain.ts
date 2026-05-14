/**
 * Production `SolanaChain` implementation: wraps a single
 * `@solana/web3.js` `Connection` plus an optional `CircuitBreaker`
 * around read methods.
 *
 * Reads are breaker-wrapped because the failure mode is "RPC is sad";
 * fast-failing further reads beats hammering an already-degraded node.
 * `sendTransaction` is NOT wrapped: retry policy lives in
 * `common/solana-tx.ts::submitConfirmed`, and stacking a circuit
 * breaker on top of in-flight retries confuses semantics.
 */
import {
  type AccountInfo,
  type BlockhashWithExpiryBlockHeight,
  type Commitment,
  Connection,
  type PublicKey,
  type RecentPrioritizationFees,
  type SendOptions,
  type SignatureStatus,
  type SimulatedTransactionResponse,
  type VersionedTransaction,
} from '@solana/web3.js'
import { AnchorProvider, type Wallet } from '@coral-xyz/anchor'

import type { CircuitBreaker } from '#common/http/circuit-breaker'

import type { SolanaChain } from './chain.js'

export interface LiveSolanaChainOptions {
  rpcUrl: string
  commitment?: Commitment
  /**
   * Optional breaker wrapping read methods. Caller owns its lifetime
   * (so multiple chains can share a breaker, or every chain can have
   * its own — both are reasonable depending on RPC topology).
   */
  breaker?: CircuitBreaker
}

export class LiveSolanaChain implements SolanaChain {
  private readonly conn: Connection
  private readonly commitment: Commitment
  private readonly breaker?: CircuitBreaker

  constructor(opts: LiveSolanaChainOptions) {
    this.commitment = opts.commitment ?? 'confirmed'
    this.conn = new Connection(opts.rpcUrl, this.commitment)
    this.breaker = opts.breaker
  }

  getAccountInfo(pubkey: PublicKey, commitment?: Commitment) {
    return this.read(() => this.conn.getAccountInfo(pubkey, commitment ?? this.commitment))
  }

  getBalance(pubkey: PublicKey, commitment?: Commitment) {
    return this.read(() => this.conn.getBalance(pubkey, commitment ?? this.commitment))
  }

  getLatestBlockhash(commitment?: Commitment): Promise<BlockhashWithExpiryBlockHeight> {
    return this.read(() => this.conn.getLatestBlockhash(commitment ?? this.commitment))
  }

  getSlot(commitment?: Commitment) {
    return this.read(() => this.conn.getSlot(commitment ?? this.commitment))
  }

  async getSignatureStatus(signature: string): Promise<SignatureStatus | null> {
    return this.read(async () => {
      const res = await this.conn.getSignatureStatus(signature, { searchTransactionHistory: false })
      return res.value
    })
  }

  getRecentPrioritizationFees(opts?: {
    lockedWritableAccounts?: PublicKey[]
  }): Promise<RecentPrioritizationFees[]> {
    return this.read(() =>
      opts?.lockedWritableAccounts && opts.lockedWritableAccounts.length > 0
        ? this.conn.getRecentPrioritizationFees({ lockedWritableAccounts: opts.lockedWritableAccounts })
        : this.conn.getRecentPrioritizationFees(),
    )
  }

  simulateTransaction(tx: VersionedTransaction): Promise<SimulatedTransactionResponse> {
    return this.read(async () => {
      const sim = await this.conn.simulateTransaction(tx, { sigVerify: false })
      return sim.value
    })
  }

  sendTransaction(tx: VersionedTransaction, opts?: SendOptions): Promise<string> {
    // No breaker: retries + backoff live in submitConfirmed.
    return this.conn.sendTransaction(tx, opts)
  }

  anchorProvider(wallet: Wallet): AnchorProvider {
    return new AnchorProvider(this.conn, wallet, { commitment: this.commitment })
  }

  rawConnection(): Connection {
    return this.conn
  }

  // Returns the AccountInfo cast back to AccountInfo<Buffer>. web3.js
  // returns `Buffer | ParsedAccountData` in the generic, but the
  // parameterless overload we call always yields Buffer.
  private read<T>(fn: () => Promise<T>): Promise<T> {
    return this.breaker ? this.breaker.exec(fn) : fn()
  }
}

// Re-typed alias used by callers that only need account-info reads.
// Drops the parsed-data union from `getAccountInfo` so consumers don't
// need to narrow.
export type AccountInfoBuffer = AccountInfo<Buffer>
