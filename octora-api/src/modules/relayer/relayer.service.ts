import { ComputeBudgetProgram, PublicKey, SystemProgram } from "@solana/web3.js";
import { verifyWithdrawProof } from "#modules/vault";
import type { NullifierRegistry } from "./nullifier-registry.js";
import type { StealthWallet } from "./stealth-wallet.js";
import { generateStealthWallet } from "./stealth-wallet.js";
import {
  convertProofToBytes,
  convertPublicInputsToBytes,
  pubkeyToFieldHash,
} from "./proof-converter.js";
import {
  createMixerClient,
  deriveMixerPoolPDA,
  deriveNullifierPDA,
  type MixerClient,
} from "./solana-client.js";
import type {
  RelayerConfig,
  RelayerHealth,
  RelayerHealthIssue,
  RelayerStatus,
  WithdrawRequest,
  WithdrawResult,
} from "./types.js";

/**
 * Health-check thresholds. Tuned for the assumption that a relayer
 * processes O(10s) withdrawals/day in early production; bump these as
 * traffic ramps up.
 */
/** Page when hot wallet has fewer than this many withdrawals' worth of fees left. */
const LOW_BALANCE_THRESHOLD_WITHDRAWALS = 50;
/** Page when this many concurrent withdrawals share an in-flight slot. */
const QUEUE_BACKED_THRESHOLD = 25;

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
  /**
   * Per-nullifier in-flight map. We serialize concurrent withdrawal requests
   * for the same nullifier so two callers can't both pass the `isSpent` cache
   * miss, both pay gas, and race to the on-chain `init` (only one wins, the
   * other wastes gas — that's the H-2 attack).
   */
  private readonly inFlight = new Map<string, Promise<WithdrawResult>>();

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
    // Guards that don't need cross-request synchronization run first; after
    // them we serialize on `nullifierHash` so concurrent submissions for the
    // same nullifier can't both pay gas (H-2).

    // 0. Sender-side guards before we even talk to the registry:

    // 0a. The proof must be bound to *this* relayer's hot wallet. Without
    // this check, anyone can submit a proof bound to Relayer A to Relayer
    // B's API; B's hotWallet signs/pays gas, but on-chain rejects because
    // `pubkey_to_field_hash(B) != relayer_field` — gas is spent for nothing.
    // (H-1)
    const guardResult = this.guardRequest(request);
    if (guardResult) return guardResult;

    // Serialize on the nullifier — second caller short-circuits to the
    // first's result (success or failure) instead of racing on-chain.
    const inflight = this.inFlight.get(request.nullifierHash);
    if (inflight) return inflight;

    const promise = this.doProcessWithdrawal(request);
    this.inFlight.set(request.nullifierHash, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(request.nullifierHash);
    }
  }

  /** Synchronous, sender-side checks that don't require RPC or proof verification. */
  private guardRequest(request: WithdrawRequest): WithdrawResult | null {
    const failure = (error: string): WithdrawResult => ({
      success: false,
      txSignature: null,
      nullifierHash: request.nullifierHash,
      recipient: request.recipient,
      amountLamports: "0",
      feeLamports: request.fee,
      error,
    });

    // H-1: relayer-binding check. We compare base58 strings, so a mismatched
    // case or extra padding fails closed.
    if (this.client) {
      const ours = this.client.hotWallet.publicKey.toBase58();
      if (request.relayer !== ours) {
        return failure(
          "Proof relayer field does not match this relayer's hot wallet — refusing to pay gas for someone else's proof.",
        );
      }
    }

    // H-3: minimum fee. Reject before doing any expensive work.
    let feeLamports: bigint;
    try {
      feeLamports = BigInt(request.fee);
    } catch {
      return failure(`Fee is not a valid integer: ${request.fee}`);
    }
    if (feeLamports < this.config.minFeeLamports) {
      return failure(
        `Fee ${feeLamports} lamports is below the relayer's minimum ${this.config.minFeeLamports}.`,
      );
    }

    return null;
  }

  /** The actual withdrawal pipeline, run under the per-nullifier lock. */
  private async doProcessWithdrawal(request: WithdrawRequest): Promise<WithdrawResult> {
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

    // 2. Parity check: request fields must match what's bound in publicSignals.
    // The on-chain program enforces this too, but failing here saves a round trip
    // and prevents wasted gas / confusing on-chain errors when a client sends
    // mismatched body fields against an unrelated proof.
    const parity = await checkPublicSignalsParity(request);
    if (!parity.ok) {
      return {
        success: false,
        txSignature: null,
        nullifierHash: request.nullifierHash,
        recipient: request.recipient,
        amountLamports: "0",
        feeLamports: request.fee,
        error: `Public signal mismatch: ${parity.reason}`,
      };
    }

    // 3. Verify proof off-chain (fast sanity check before paying gas)
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
      balanceLamports: await this.getHotWalletBalance(),
      pendingWithdrawals: this.pendingWithdrawals,
      totalProcessed: this.totalProcessed,
      nullifierCount: await this.nullifiers.count(),
    };
  }

  /**
   * Monitoring-shaped health snapshot. Designed to be polled by external
   * alerting (Grafana, Datadog, Pingdom). The `healthy` flag flips false
   * when any of the failure conditions in `LOW_BALANCE_*` /
   * `QUEUE_BACKED_*` thresholds trip — see `relayer.routes.ts` which
   * maps `healthy === false` to HTTP 503.
   */
  async health(): Promise<RelayerHealth> {
    const issues: RelayerHealthIssue[] = [];

    if (!this.client || !this.mixerPoolPDA) {
      issues.push("client_uninitialized");
    }

    const balanceLamports = await this.getHotWalletBalance();
    const balanceBn = balanceLamports === "0" ? 0n : BigInt(balanceLamports);
    const minFee = this.config.minFeeLamports;
    // Below ~10 minFees = "you have a day-or-two worth of gas left".
    // Operators should top up before this fires; the alert is the floor.
    const withdrawalsBudget = minFee > 0n ? Number(balanceBn / minFee) : 0;
    if (withdrawalsBudget < LOW_BALANCE_THRESHOLD_WITHDRAWALS) {
      issues.push("low_balance");
    }

    if (this.inFlight.size >= QUEUE_BACKED_THRESHOLD) {
      issues.push("queue_backed_up");
    }

    return {
      healthy: issues.length === 0,
      issues,
      publicKey: this.getHotWalletPublicKey(),
      balanceLamports,
      withdrawalsBudget,
      pendingWithdrawals: this.pendingWithdrawals,
      inFlightNullifiers: this.inFlight.size,
      totalProcessed: this.totalProcessed,
      nullifierCount: await this.nullifiers.count(),
      minFeeLamports: minFee.toString(),
      poolDenomination: this.config.poolDenomination.toString(),
    };
  }

  /** Validate a proof without submitting (dry-run for UX). */
  async validateProof(request: WithdrawRequest): Promise<{ valid: boolean; reason?: string }> {
    // Same sender-side guards as processWithdrawal, so dry-run results
    // accurately predict whether processWithdrawal would accept the request.
    const guard = this.guardRequest(request);
    if (guard) {
      return { valid: false, reason: guard.error };
    }

    const spent = await this.nullifiers.isSpent(request.nullifierHash);
    if (spent) {
      return { valid: false, reason: "Nullifier already spent." };
    }

    const parity = await checkPublicSignalsParity(request);
    if (!parity.ok) {
      return { valid: false, reason: `Public signal mismatch: ${parity.reason}` };
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

type ParityResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify that the request body matches what's bound in the proof's publicSignals.
 *
 * publicSignals layout from withdraw.circom:
 *   [0] root, [1] nullifierHash, [2] recipient (field), [3] relayer (field), [4] fee
 *
 * Each entry is a decimal-string BN254 field element. Pubkeys end up there as
 * `Poseidon(hi, lo)` over the two 16-byte halves of the pubkey bytes, the
 * same scheme the on-chain `pubkey_to_field_hash` uses. Async because the
 * Poseidon implementation in the vault module is async.
 */
async function checkPublicSignalsParity(request: WithdrawRequest): Promise<ParityResult> {
  const sigs = request.publicSignals;
  if (!sigs || sigs.length !== 5) {
    return { ok: false, reason: `expected 5 publicSignals, got ${sigs?.length ?? 0}` };
  }

  try {
    const [sigRoot, sigNul, sigRec, sigRel, sigFee] = sigs.map((s) => BigInt(s));

    if (BigInt(request.root) !== sigRoot) return { ok: false, reason: "root mismatch" };
    if (BigInt(request.nullifierHash) !== sigNul) return { ok: false, reason: "nullifierHash mismatch" };
    if (BigInt(request.fee) !== sigFee) return { ok: false, reason: "fee mismatch" };

    const recPub = new PublicKey(request.recipient);
    const relPub = new PublicKey(request.relayer);
    const [recHash, relHash] = await Promise.all([
      pubkeyToFieldHash(recPub),
      pubkeyToFieldHash(relPub),
    ]);
    if (recHash !== sigRec) return { ok: false, reason: "recipient mismatch" };
    if (relHash !== sigRel) return { ok: false, reason: "relayer mismatch" };

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "parity parse error" };
  }
}
