import type { Groth16Proof } from "#modules/vault";

/** A withdrawal request submitted to the relayer. */
export interface WithdrawRequest {
  proof: Groth16Proof;
  publicSignals: string[];
  /** Merkle root the proof was generated against. */
  root: string;
  /** Hash of the nullifier — prevents double-spend. */
  nullifierHash: string;
  /** The stealth address (recipient) that will receive funds. */
  recipient: string;
  /** Relayer address that will submit the tx (earns fee). */
  relayer: string;
  /** Fee in lamports deducted from the withdrawal. */
  fee: string;
}

/** Result of a relayer withdrawal execution. */
export interface WithdrawResult {
  success: boolean;
  txSignature: string | null;
  nullifierHash: string;
  recipient: string;
  amountLamports: string;
  feeLamports: string;
  error?: string;
}

/** Deposit record stored by the relayer for Merkle tree reconstruction. */
export interface DepositRecord {
  commitment: string;
  leafIndex: number;
  blockTime: number;
  txSignature: string;
}

/** Relayer hot wallet status. */
export interface RelayerStatus {
  publicKey: string;
  balanceLamports: string;
  pendingWithdrawals: number;
  totalProcessed: number;
  nullifierCount: number;
}

/**
 * Monitoring-friendly health payload. The `healthy` flag is the single
 * scalar an alerting system should page on; the breakdown lets a human
 * see *why* it's unhealthy on the same response.
 */
export interface RelayerHealth {
  healthy: boolean;
  /** Set of failed health checks. Empty when `healthy === true`. */
  issues: RelayerHealthIssue[];
  publicKey: string;
  balanceLamports: string;
  /**
   * Hot-wallet balance expressed in withdrawals' worth of fees, i.e.
   * `balance / minFeeLamports`. Useful for "we have N withdrawals left
   * before we run dry" alerting that doesn't require knowing what the
   * minFee is at query time.
   */
  withdrawalsBudget: number;
  pendingWithdrawals: number;
  inFlightNullifiers: number;
  totalProcessed: number;
  nullifierCount: number;
  minFeeLamports: string;
  poolDenomination: string;
}

export type RelayerHealthIssue =
  | "client_uninitialized"
  | "low_balance"
  | "queue_backed_up";

/** Configuration for the relayer service. */
export interface RelayerConfig {
  /** Base fee in lamports charged per withdrawal. */
  baseFeelamports: bigint;
  /**
   * Minimum acceptable fee bound in the proof.
   *
   * The on-chain program enforces `fee < denomination` but does NOT enforce a
   * floor — without this guard the relayer can be made to pay gas with no
   * compensation by submitting fee=0 proofs at scale. Set this to cover the
   * relayer's worst-case priority fee plus a small margin.
   */
  minFeeLamports: bigint;
  /**
   * Hot wallet secret. Either:
   *   - inline JSON byte array (`"[12,34,...,89]"`), or
   *   - `file:<path>` to a JSON keypair file with mode 0600.
   * Bare paths are no longer accepted (see solana-client.ts loadHotWallet).
   */
  hotWalletSecret: string;
  /** RPC endpoint for submitting transactions. */
  rpcUrl: string;
  /** Mixer program ID on-chain. */
  mixerProgramId: string;
  /** Denomination in lamports for the fixed-amount pool. */
  poolDenomination: bigint;
}
