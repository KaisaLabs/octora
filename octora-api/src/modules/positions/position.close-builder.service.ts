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
 * Vertical-slice contract. The returned transaction is a *structurally
 * valid* unsigned tx with the right feePayer and a fresh blockhash, so
 * the browser-side signing + broadcast path is exercised end-to-end.
 * The actual on-chain instructions are the minimal placeholder
 * (`SystemProgram.transfer` of 0 lamports from signer to signer) — this
 * keeps the tx well-formed without depending on the heavyweight DLMM
 * adapter + ZK proof construction that the production builders need.
 * The orchestrator's never-touch-`/relayer/*` invariant is fully
 * testable against this shape today; the production ix wiring lives
 * inside this service so future commits can swap the placeholder for
 * the real DLMM / mixer.deposit builders without changing the route.
 */
import {
  PublicKey,
  SystemProgram,
  Transaction,
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

export interface CloseBuilderDeps {
  chain: SolanaChain;
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
  // Placeholder ix that is well-formed and unsigned (signer is the only
  // required signature, which the browser will provide).
  tx.add(
    SystemProgram.transfer({
      fromPubkey: signer,
      toPubkey: signer,
      lamports: 0,
    }),
  );

  // Resolve min-out for the swap leg so the caller can echo it back to
  // the activity row. Production swap ix will consume this directly;
  // the placeholder ix ignores it but the contract is observable.
  let minAmountOutLamports: string | undefined;
  if (input.leg === "swap" && input.expectedSwapOutLamports && input.slippageBps) {
    const expected = input.expectedSwapOutLamports;
    const bps = BigInt(input.slippageBps);
    minAmountOutLamports = (
      (expected * (10_000n - bps)) /
      10_000n
    ).toString();
  }

  const serialized = tx.serialize({ requireAllSignatures: false });
  return {
    transaction: serialized.toString("base64"),
    leg: input.leg,
    ...(minAmountOutLamports ? { minAmountOutLamports } : {}),
  };
}
