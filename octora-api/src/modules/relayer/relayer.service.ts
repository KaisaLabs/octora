import { ComputeBudgetProgram, PublicKey, SystemProgram } from "@solana/web3.js";
import { verifyWithdrawProof } from "#modules/vault";
import type { NullifierRegistry } from "./nullifier-registry.js";
import type { StealthWallet } from "./stealth-wallet.js";
import { generateStealthWallet } from "./stealth-wallet.js";
import { convertProofToBytes, convertPublicInputsToBytes } from "./proof-converter.js";
import {
  createMixerClient,
  deriveMixerPoolPDA,
  deriveNullifierPDA,
  type MixerClient,
} from "./solana-client.js";
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
  private client: MixerClient | null = null;
  private mixerPoolPDA: PublicKey | null = null;

  constructor(
    private readonly config: RelayerConfig,
    private readonly nullifiers: NullifierRegistry,
  ) {}

  /**
   * Initialize the Solana client connection.
   * Must be called before processing withdrawals.
   */
  initializeClient(): void {
    this.client = createMixerClient(this.config);
    const [poolPDA] = deriveMixerPoolPDA(
      this.client.programId,
      this.config.poolDenomination,
    );
    this.mixerPoolPDA = poolPDA;
  }

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

    // 3. Submit on-chain withdrawal transaction
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

    // 4. Mark nullifier as spent
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
      balanceLamports: await this.getHotWalletBalance(),
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
   */
  private async submitWithdrawalTx(request: WithdrawRequest): Promise<string> {
    this.ensureClientInitialized();

    const { program, hotWallet, programId } = this.client!;
    const mixerPoolKey = this.mixerPoolPDA!;

    // Convert proof and public inputs to packed byte format
    const proofBytes = convertProofToBytes(request.proof);
    const publicInputsBytes = convertPublicInputsToBytes(request.publicSignals);

    // Derive nullifier PDA
    const nullifierHashBuf = Buffer.from(
      BigInt(request.nullifierHash).toString(16).padStart(64, "0"),
      "hex",
    );
    const [nullifierPDA] = deriveNullifierPDA(programId, mixerPoolKey, nullifierHashBuf);

    const recipientKey = new PublicKey(request.recipient);
    const relayerKey = hotWallet.publicKey;

    // Build and send the withdraw instruction
    const tx = await program.methods
      .withdraw(
        Array.from(proofBytes) as number[],
        Array.from(publicInputsBytes) as number[],
      )
      .accounts({
        signer: hotWallet.publicKey,
        mixerPool: mixerPoolKey,
        nullifierAccount: nullifierPDA,
        recipient: recipientKey,
        relayer: relayerKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .signers([hotWallet])
      .rpc({ commitment: "confirmed" });

    return tx;
  }

  private getHotWalletPublicKey(): string {
    if (this.client) {
      return this.client.hotWallet.publicKey.toBase58();
    }
    return "NOT_INITIALIZED";
  }

  private async getHotWalletBalance(): Promise<string> {
    if (!this.client) return "0";
    const balance = await this.client.provider.connection.getBalance(
      this.client.hotWallet.publicKey,
    );
    return balance.toString();
  }

  private ensureClientInitialized(): void {
    if (!this.client || !this.mixerPoolPDA) {
      throw new Error(
        "RelayerService Solana client not initialized. Call initializeClient() first.",
      );
    }
  }
}
