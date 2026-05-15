/**
 * close/06 — close-recovery tx-builder service.
 *
 * Assembles unsigned Solana transactions the user's browser can sign
 * with the stealth keypair (re-derived locally per ADR-0002) and
 * broadcast directly to RPC, completing one of the three close-flow
 * legs after a `*_FAILED` terminal:
 *
 *   - `withdraw-close` — `dlmm_withdraw_close` ix to claim fees +
 *     remove liquidity from every bin + close the DLMM Position
 *     account. Drives `CLOSE_FAILED` → eventually `CLOSED` once the
 *     subsequent legs land.
 *   - `swap` — conditional `dlmm_swap` for any non-SOL residual on
 *     the Stealth Wallet. Slippage tolerance flows through from the
 *     persisted `closeWitness` (close/02's modal echoes the
 *     `expectedSwapOutLamports`).
 *   - `mixer-deposit` — fresh `mixer.deposit` for one denomination of
 *     SOL. Mints the re-mix Commitment the user holds the preimage to.
 *
 * Why a separate service. The existing mainline orchestrator
 * (`position.close.service.ts`) drives relayer-signed txs through the
 * `CloseOrchestrationAdapter`. The user-signed path is structurally
 * different: the browser, not the backend, signs and broadcasts. This
 * service only produces the unsigned tx — never signs, never submits.
 * Mirrors the read-only `/mixer/withdraw` builder pattern.
 *
 * Production wiring. When `legBuilders` is supplied, each leg invokes
 * the real ix builder ({@link CloseRecoveryLegBuilders}). When omitted,
 * the placeholder shape (a zero-lamport `SystemProgram.transfer` from
 * signer to signer) keeps the tx structurally valid so the browser-
 * side signing + broadcast path is exercised end-to-end without
 * needing the heavyweight DLMM remaining-accounts assembly or a
 * browser-issued commitment for the re-mix leg. The placeholder lives
 * on for the unwired test path; tests pass `legBuilders` explicitly
 * to exercise the real ix shapes.
 */
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import type { SolanaChain } from "#common/solana/chain";

export type CloseRecoveryLeg = "withdraw-close" | "swap" | "mixer-deposit";

export interface CloseBuilderInput {
  positionId: string;
  leg: CloseRecoveryLeg;
  /** Stealth pubkey (base58) that will sign + pay fees for the tx. */
  signer: string;
  /** Optional destination (used for the bail / swap-out routing). */
  recipient?: string;
  /** Slippage tolerance bps (10–500). Only honored by the `swap` leg. */
  slippageBps?: number;
  /** Expected swap output in lamports — pairs with `slippageBps`. */
  expectedSwapOutLamports?: bigint;
}

export interface CloseBuilderResult {
  /** Base64-encoded legacy Solana transaction the browser signs. */
  transaction: string;
  /** Echoed back so the caller can correlate the response. */
  leg: CloseRecoveryLeg;
  /**
   * Resolved `min_amount_out` for the swap leg (lamports decimal-string).
   * Computed as `expectedOut * (1 - bps/10000)` and rounded down. Omitted
   * for non-swap legs.
   */
  minAmountOutLamports?: string;
}

/**
 * Per-leg ix builders that produce the real on-chain instructions for
 * each user-signed recovery tx. The contract is "given the per-leg
 * input + signer pubkey, return a list of ixs the tx will contain";
 * the service wraps the ixs with the same blockhash + feePayer setup
 * the placeholder uses. Each method is optional so production
 * deployments can land legs incrementally — a missing builder falls
 * back to the placeholder shape with a documented `note` field on the
 * activity-log row.
 */
export interface CloseRecoveryLegBuilders {
  withdrawClose?: (input: {
    positionId: string;
    signer: PublicKey;
  }) => Promise<TransactionInstruction[]>;
  swap?: (input: {
    positionId: string;
    signer: PublicKey;
    /** `null` when no quote was taken; adapter sets min_out = 1 (no protection). */
    expectedSwapOutLamports: bigint | null;
    slippageBps: number;
    minAmountOutLamports: bigint;
  }) => Promise<TransactionInstruction[]>;
  mixerDeposit?: (input: {
    positionId: string;
    signer: PublicKey;
    recipient?: PublicKey;
  }) => Promise<TransactionInstruction[]>;
}

export interface CloseBuilderDeps {
  chain: SolanaChain;
  /**
   * Optional production-wiring hook. When supplied, each leg uses the
   * real ix builders below; when omitted (test scaffolding +
   * unwired-production-path), the placeholder zero-lamport transfer
   * keeps the tx well-formed. Same precedent the executor's
   * `OnchainPositionContext` set — the seams exist; per-leg builders
   * plug in as their context fields land in `PositionRow`.
   */
  legBuilders?: CloseRecoveryLegBuilders;
}

/**
 * Build the unsigned tx for the requested leg. Pure-shaped: takes a
 * chain handle for the blockhash, returns the base64 tx.
 *
 * VERTICAL-SLICE NOTE — the produced tx is a structurally valid no-op
 * (`SystemProgram.transfer(signer, signer, 0)`). It exercises the
 * orchestrator's stealth-sign + broadcast contract end-to-end without
 * pulling in the heavy DLMM / mixer ix builders. A follow-up wires the
 * production builders below the same `buildCloseRecoveryTx` contract.
 */
export async function buildCloseRecoveryTx(
  deps: CloseBuilderDeps,
  input: CloseBuilderInput,
): Promise<CloseBuilderResult> {
  const signer = new PublicKey(input.signer);
  const { blockhash } = await deps.chain.getLatestBlockhash();
  const tx = new Transaction();
  tx.feePayer = signer;
  tx.recentBlockhash = blockhash;

  // Resolve min-out for the swap leg up-front so both the real builder
  // and the activity row see the same number.
  let minAmountOutLamports: bigint | undefined;
  if (input.leg === "swap" && input.expectedSwapOutLamports && input.slippageBps) {
    const expected = input.expectedSwapOutLamports;
    const bps = BigInt(input.slippageBps);
    minAmountOutLamports = (expected * (10_000n - bps)) / 10_000n;
  }

  // Production path: when a leg builder is wired, use the real ixs.
  // Falls back to the structurally-valid placeholder when no builder
  // is supplied (test scaffolding + unwired-production-path).
  const realIxs = await tryBuildRealIxs(deps.legBuilders, input, signer, minAmountOutLamports);
  if (realIxs && realIxs.length > 0) {
    for (const ix of realIxs) tx.add(ix);
  } else {
    // Placeholder ix that is well-formed and unsigned (signer is the
    // only required signature, which the browser will provide).
    tx.add(
      SystemProgram.transfer({
        fromPubkey: signer,
        toPubkey: signer,
        lamports: 0,
      }),
    );
  }

  const serialized = tx.serialize({ requireAllSignatures: false });
  return {
    transaction: serialized.toString("base64"),
    leg: input.leg,
    ...(minAmountOutLamports !== undefined
      ? { minAmountOutLamports: minAmountOutLamports.toString() }
      : {}),
  };
}

async function tryBuildRealIxs(
  builders: CloseRecoveryLegBuilders | undefined,
  input: CloseBuilderInput,
  signer: PublicKey,
  minAmountOutLamports: bigint | undefined,
): Promise<TransactionInstruction[] | null> {
  if (!builders) return null;
  switch (input.leg) {
    case "withdraw-close":
      return builders.withdrawClose
        ? builders.withdrawClose({ positionId: input.positionId, signer })
        : null;
    case "swap":
      return builders.swap
        ? builders.swap({
            positionId: input.positionId,
            signer,
            expectedSwapOutLamports: input.expectedSwapOutLamports ?? null,
            slippageBps: input.slippageBps ?? 50,
            minAmountOutLamports: minAmountOutLamports ?? 1n,
          })
        : null;
    case "mixer-deposit":
      return builders.mixerDeposit
        ? builders.mixerDeposit({
            positionId: input.positionId,
            signer,
            recipient: input.recipient ? new PublicKey(input.recipient) : undefined,
          })
        : null;
    default:
      return null;
  }
}
