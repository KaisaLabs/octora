/**
 * Thin seam over `@solana/web3.js` `Connection`. Every module that
 * needs to read or write on-chain state takes a `SolanaChain` instead
 * of building its own `new Connection(rpcUrl)`. Two benefits:
 *
 *   - Locality: one place to wire retry policy, circuit breaking,
 *     OTel spans, RPC URL rotation. Was previously duplicated across
 *     ~12 callsites.
 *   - Testability: callers can be exercised against `ScriptedChain`
 *     (in-memory, deterministic) without hitting an RPC.
 *
 * Surface is intentionally narrow — only the methods the codebase
 * actually uses today. Growing it requires touching every adapter,
 * which is the desired forcing function.
 */
import type {
  AccountInfo,
  BlockhashWithExpiryBlockHeight,
  Commitment,
  Connection,
  PublicKey,
  RecentPrioritizationFees,
  SendOptions,
  SignatureStatus,
  SimulatedTransactionResponse,
  VersionedTransaction,
} from '@solana/web3.js'
import type { AnchorProvider, Wallet } from '@coral-xyz/anchor'

export interface SolanaChain {
  getAccountInfo(
    pubkey: PublicKey,
    commitment?: Commitment,
  ): Promise<AccountInfo<Buffer> | null>

  getBalance(pubkey: PublicKey, commitment?: Commitment): Promise<number>

  getLatestBlockhash(commitment?: Commitment): Promise<BlockhashWithExpiryBlockHeight>

  getSlot(commitment?: Commitment): Promise<number>

  getSignatureStatus(
    signature: string,
    opts?: { searchTransactionHistory?: boolean },
  ): Promise<SignatureStatus | null>

  getRecentPrioritizationFees(opts?: {
    lockedWritableAccounts?: PublicKey[]
  }): Promise<RecentPrioritizationFees[]>

  simulateTransaction(tx: VersionedTransaction): Promise<SimulatedTransactionResponse>

  sendTransaction(tx: VersionedTransaction, opts?: SendOptions): Promise<string>

  /**
   * Build an Anchor `Provider` over the underlying connection. Used by
   * the executor + relayer to load `Program` instances. Read-only
   * chains (DLMM cluster reads) may throw `UnsupportedChainOperationError`.
   */
  anchorProvider(wallet: Wallet): AnchorProvider

  /**
   * Escape hatch for libraries that demand a raw `Connection` (Meteora
   * SDK, `submitConfirmed`). Use sparingly — every call here is a
   * place the seam is leaking.
   */
  rawConnection(): Connection
}

export class UnsupportedChainOperationError extends Error {
  constructor(operation: string) {
    super(`SolanaChain operation not supported: ${operation}`)
    this.name = 'UnsupportedChainOperationError'
  }
}
