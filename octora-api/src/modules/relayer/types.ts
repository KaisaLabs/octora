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

/** Configuration for the relayer service. */
export interface RelayerConfig {
  /** Base fee in lamports charged per withdrawal. */
  baseFeelamports: bigint;
  /** Hot wallet secret key (base58 or byte array path). */
  hotWalletSecret: string;
  /** RPC endpoint for submitting transactions. */
  rpcUrl: string;
  /** Mixer program ID on-chain. */
  mixerProgramId: string;
  /** Denomination in lamports for the fixed-amount pool. */
  poolDenomination: bigint;
  /**
   * Privacy delay gate, in milliseconds. The relayer rejects a withdrawal
   * whose Merkle root the relayer first observed less than this many ms ago.
   * This prevents the trivial "deposit, withdraw next slot" timing
   * correlation that collapses the anonymity set on a low-traffic pool.
   *
   * Defaults to 13_000 (~32 Solana slots @ 400ms). Set to 0 to disable
   * (tests, localnet smoke). The cap is intentionally low — meaningful
   * privacy comes from anonymity-set growth, not delay alone.
   */
  privacyDelayMs?: number;
}
