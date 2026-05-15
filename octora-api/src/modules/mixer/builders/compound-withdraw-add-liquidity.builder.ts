/**
 * Backend boundary guard for the on-chain `compound_withdraw_add_liquidity`
 * instruction (see `programs/octora-executor/src/instructions/dlmm/compound.rs`).
 *
 * The on-chain entrypoint is intentionally fail-closed per ADR-0003
 * (`octora-api/docs/adr/0003-compound-mixer-dlmm-cpi-remains-fail-closed.md`):
 * it validates the canonical Mixer and DLMM program IDs and then returns
 * `ExecutorError::CompoundCpiUnsupported (6020)` without moving any funds.
 *
 * This module exists so that any backend code that *thinks* it can build a
 * transaction against that ix gets a typed error at the boundary, not a
 * silently-broken tx that gets all the way to the validator before failing.
 * It is the dual of the on-chain `err!(...)`: an explicit "not wired yet"
 * gate that future call sites trip over until ADR-0003 is superseded.
 *
 * When the real CPI implementation lands:
 *  1. Replace the body of `buildCompoundWithdrawAddLiquidityTransaction`
 *     with the real tx-assembly code (mirror the pattern in
 *     `withdraw.builder.ts`).
 *  2. Delete `CompoundCpiNotImplementedError` or convert it into a
 *     narrower error for genuinely-unsupported inputs.
 *  3. Update ADR-0003's status to Superseded and reference the new ADR.
 */
import { ValidationError } from "#common/errors";

import type { MixerTxContext } from "./types.js";

/**
 * Thrown when a backend code path attempts to construct a transaction
 * that invokes the on-chain `compound_withdraw_add_liquidity` ix while
 * ADR-0003 keeps it fail-closed.
 *
 * Extends `ValidationError` (422) — semantically the request is
 * well-formed but targets an action the backend refuses to wire. The
 * stable `code` is `compound_cpi_not_implemented` so the frontend (and
 * any operator dashboard) can match without relying on the message.
 */
export class CompoundCpiNotImplementedError extends ValidationError {
  constructor(detail?: string) {
    super(
      `compound_withdraw_add_liquidity is fail-closed (ADR-0003).` +
        (detail ? ` ${detail}` : ""),
      { code: "compound_cpi_not_implemented" },
    );
    this.name = "CompoundCpiNotImplementedError";
  }
}

export interface BuildCompoundWithdrawAddLiquidityArgs {
  /** Relayer pubkey that would sign + pay tx fees. */
  relayerPubkey: string;
  /** Stealth wallet pubkey that owns the DLMM Position. */
  stealthPubkey: string;
  /** Groth16 proof bytes (base64) the on-chain ix would forward to mixer. */
  withdrawProofBase64: string;
  /** BN254 public inputs (base64). */
  withdrawPublicInputsBase64: string;
  /** Borsh-encoded DLMM `add_liquidity` parameters. */
  liquidityParamsBase64: string;
}

/**
 * Refuses to build a tx for `compound_withdraw_add_liquidity`.
 *
 * This is **not** a comment, **not** a TODO — it throws at runtime so
 * that accidental wiring (a stray `executor.compoundWithdrawAddLiquidity(...)`
 * call site, an experimental route handler, a forgotten branch) raises
 * a typed, traceable error instead of silently constructing an
 * unsignable transaction.
 *
 * The arguments are typed but otherwise unused — they exist so call
 * sites compile against the eventual real shape, making the diff to
 * enable the path mechanical when ADR-0003 is superseded.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function buildCompoundWithdrawAddLiquidityTransaction(
  _ctx: MixerTxContext,
  _args: BuildCompoundWithdrawAddLiquidityArgs,
): Promise<{ transaction: string }> {
  throw new CompoundCpiNotImplementedError(
    "On-chain entrypoint returns ExecutorError::CompoundCpiUnsupported; " +
      "backend must not route production traffic to this ix until the ADR " +
      "is superseded.",
  );
}
