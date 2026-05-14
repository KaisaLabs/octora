/**
 * In-memory `SolanaChain` for tests. Preload responses; every call
 * is recorded for assertions. Throws on any unconfigured read so
 * tests can't silently rely on accidental defaults.
 *
 * Not a full RPC mock — only the methods the seam exposes, and only
 * the response shapes the codebase consumes today. Grow it by
 * editing this file when a real test needs more.
 */
import type {
  AccountInfo,
  BlockhashWithExpiryBlockHeight,
  Commitment,
  PublicKey,
  RecentPrioritizationFees,
  SendOptions,
  SignatureStatus,
  SimulatedTransactionResponse,
  VersionedTransaction,
} from '@solana/web3.js'
import type { AnchorProvider, Wallet } from '@coral-xyz/anchor'

import { type SolanaChain, UnsupportedChainOperationError } from './chain.js'

export interface ScriptedChainState {
  /** Map keyed by base58 pubkey. `null` value = explicit "no account". */
  accounts?: Record<string, AccountInfo<Buffer> | null>
  /** Map keyed by base58 pubkey. Missing entry defaults to 0. */
  balances?: Record<string, number>
  slot?: number
  blockhash?: BlockhashWithExpiryBlockHeight
  /** Keyed by signature; missing entry yields `null`. */
  signatureStatuses?: Record<string, SignatureStatus | null>
  prioritizationFees?: RecentPrioritizationFees[]
  simulationResult?: SimulatedTransactionResponse
  /** Signature returned by sendTransaction. Default 'scripted-sig'. */
  sendResult?: string
}

export interface ScriptedCall {
  method: string
  args: unknown[]
}

export class ScriptedChain implements SolanaChain {
  readonly calls: ScriptedCall[] = []

  constructor(private state: ScriptedChainState = {}) {}

  /** Mutate the scripted state mid-test (e.g. simulate a pool becoming initialized). */
  update(patch: Partial<ScriptedChainState>): void {
    this.state = { ...this.state, ...patch }
  }

  async getAccountInfo(pubkey: PublicKey, commitment?: Commitment) {
    this.calls.push({ method: 'getAccountInfo', args: [pubkey.toBase58(), commitment] })
    const key = pubkey.toBase58()
    const accounts = this.state.accounts ?? {}
    if (!(key in accounts)) {
      // Missing entry = "no account" — matches mainnet behaviour for
      // unknown pubkeys and avoids forcing every test to enumerate.
      return null
    }
    return accounts[key]
  }

  async getBalance(pubkey: PublicKey, commitment?: Commitment) {
    this.calls.push({ method: 'getBalance', args: [pubkey.toBase58(), commitment] })
    return this.state.balances?.[pubkey.toBase58()] ?? 0
  }

  async getLatestBlockhash(commitment?: Commitment): Promise<BlockhashWithExpiryBlockHeight> {
    this.calls.push({ method: 'getLatestBlockhash', args: [commitment] })
    return (
      this.state.blockhash ?? {
        blockhash: 'ScriptedBlockhash1111111111111111111111111111',
        lastValidBlockHeight: 1_000_000,
      }
    )
  }

  async getSlot(commitment?: Commitment) {
    this.calls.push({ method: 'getSlot', args: [commitment] })
    return this.state.slot ?? 0
  }

  async getSignatureStatus(signature: string): Promise<SignatureStatus | null> {
    this.calls.push({ method: 'getSignatureStatus', args: [signature] })
    const statuses = this.state.signatureStatuses ?? {}
    return signature in statuses ? statuses[signature] : null
  }

  async getRecentPrioritizationFees(opts?: {
    lockedWritableAccounts?: PublicKey[]
  }): Promise<RecentPrioritizationFees[]> {
    this.calls.push({
      method: 'getRecentPrioritizationFees',
      args: [opts?.lockedWritableAccounts?.map((k) => k.toBase58())],
    })
    return this.state.prioritizationFees ?? []
  }

  async simulateTransaction(tx: VersionedTransaction): Promise<SimulatedTransactionResponse> {
    this.calls.push({ method: 'simulateTransaction', args: [tx] })
    return (
      this.state.simulationResult ?? {
        err: null,
        logs: [],
        accounts: null,
        unitsConsumed: 200_000,
        returnData: null,
        innerInstructions: null,
      }
    )
  }

  async sendTransaction(tx: VersionedTransaction, opts?: SendOptions): Promise<string> {
    this.calls.push({ method: 'sendTransaction', args: [tx, opts] })
    return this.state.sendResult ?? 'scripted-sig'
  }

  anchorProvider(_wallet: Wallet): AnchorProvider {
    throw new UnsupportedChainOperationError('anchorProvider')
  }

  rawConnection(): never {
    throw new UnsupportedChainOperationError('rawConnection')
  }
}
