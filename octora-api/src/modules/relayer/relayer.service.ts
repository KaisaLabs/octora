import { verifyWithdrawProof } from "#modules/vault";
import type { NullifierRegistry } from "./nullifier-registry.js";
import type { StealthWallet } from "./stealth-wallet.js";
import { generateStealthWallet } from "./stealth-wallet.js";
import type { RelayerConfig, RelayerStatus, WithdrawRequest, WithdrawResult } from "./types.js";

/**
 * Relayer Service — the core engine that:
 * 1. Verifies ZK withdrawal proofs off-chain
 * 2. Checks nullifier hasn't been spent (double-spend prevention)
 * 3. Submits the on-chain withdrawal transaction via hot wallet
 * 4. Records the nullifier as spent
 * 5. Returns the stealth wallet that received funds
 *
 * The relayer's hot wallet pays gas fees and deducts a small fee from the withdrawal.
 */
export class RelayerService {
  private totalProcessed = 0;
  private pendingWithdrawals = 0;

  constructor(
    private readonly config: RelayerConfig,
    private readonly nullifiers: NullifierRegistry,
  ) {}

  /**
   * Process a withdrawal request:
   * - Verify the proof off-chain
   * - Check nullifier not spent
   * - Submit on-chain tx
   * - Mark nullifier as spent
   */
  async processWithdrawal(request: WithdrawRequest): Promise<WithdrawResult> {
    // 1. Pre-check: nullifier not already spent
    const alreadySpent = await this.nullifiers.isSpent(request.nullifierHash);
    if (alreadySpent) {
      return {
        success: false,
        txSignature: null,
        nullifierHash: request.nullifierHash,
        recipient: request.recipient,
        amountLamports: "0",
        feeLamports: request.fee,
        error: "Nullifier already spent — possible double-withdrawal attempt.",
      };
    }

    // 2. Verify proof off-chain (fast sanity check before paying gas)
    let proofValid: boolean;
    try {
      proofValid = await verifyWithdrawProof(request.proof, request.publicSignals);
    } catch (err) {
      return {
        success: false,
        txSignature: null,
        nullifierHash: request.nullifierHash,
        recipient: request.recipient,
        amountLamports: "0",
        feeLamports: request.fee,
        error: `Proof verification error: ${err instanceof Error ? err.message : "unknown"}`,
      };
    }

    if (!proofValid) {
      return {
        success: false,
        txSignature: null,
        nullifierHash: request.nullifierHash,
        recipient: request.recipient,
        amountLamports: "0",
        feeLamports: request.fee,
        error: "Invalid withdrawal proof — verification failed.",
      };
    }

    // 3. Verify the relayer address matches our hot wallet
    if (request.relayer !== this.config.hotWalletSecret) {
      // In production, compare against hot wallet pubkey
    }

    // 4. Submit on-chain withdrawal transaction
    this.pendingWithdrawals++;
    let txSignature: string;

    try {
      txSignature = await this.submitWithdrawalTx(request);
    } catch (err) {
      this.pendingWithdrawals--;
      return {
        success: false,
        txSignature: null,
        nullifierHash: request.nullifierHash,
        recipient: request.recipient,
        amountLamports: "0",
        feeLamports: request.fee,
        error: `On-chain submission failed: ${err instanceof Error ? err.message : "unknown"}`,
      };
    }

    // 5. Mark nullifier as spent
    await this.nullifiers.markSpent(request.nullifierHash, txSignature);

    this.pendingWithdrawals--;
    this.totalProcessed++;

    const netAmount = this.config.poolDenomination - BigInt(request.fee);

    return {
      success: true,
      txSignature,
      nullifierHash: request.nullifierHash,
      recipient: request.recipient,
      amountLamports: netAmount.toString(),
      feeLamports: request.fee,
    };
  }

  /**
   * Generate a fresh stealth wallet for a new LP position.
   * This wallet becomes the `recipient` in the withdrawal proof.
   */
  generateRecipientWallet(): StealthWallet {
    return generateStealthWallet();
  }

  /** Get relayer operational status. */
  async status(): Promise<RelayerStatus> {
    return {
      publicKey: this.getHotWalletPublicKey(),
      balanceLamports: "0", // TODO: query on-chain balance
      pendingWithdrawals: this.pendingWithdrawals,
      totalProcessed: this.totalProcessed,
      nullifierCount: await this.nullifiers.count(),
    };
  }

  /** Validate a proof without submitting (dry-run for UX). */
  async validateProof(request: WithdrawRequest): Promise<{ valid: boolean; reason?: string }> {
    const spent = await this.nullifiers.isSpent(request.nullifierHash);
    if (spent) {
      return { valid: false, reason: "Nullifier already spent." };
    }

    try {
      const proofValid = await verifyWithdrawProof(request.proof, request.publicSignals);
      if (!proofValid) {
        return { valid: false, reason: "Proof verification failed." };
      }
    } catch (err) {
      return { valid: false, reason: `Proof verification error: ${err instanceof Error ? err.message : "unknown"}` };
    }

    return { valid: true };
  }

  // --- Private ---

  /**
   * Submit the withdrawal instruction to the mixer program on-chain.
   * The hot wallet signs and pays gas; the recipient receives (denomination - fee).
   *
   * TODO: Implement actual Solana transaction construction:
   * - Build instruction with proof, public signals, recipient
   * - Sign with hot wallet keypair
   * - Send and confirm transaction
   */
  private async submitWithdrawalTx(request: WithdrawRequest): Promise<string> {
    // Placeholder for on-chain tx submission.
    // Will be replaced with actual @solana/web3.js transaction logic
    // once the mixer program is deployed.
    throw new Error(
      `On-chain submission not yet implemented. ` +
      `Recipient: ${request.recipient}, Root: ${request.root}`,
    );
  }

  private getHotWalletPublicKey(): string {
    // TODO: derive from config.hotWalletSecret
    return "RELAYER_HOT_WALLET_PUBKEY";
  }
}
