/**
 * Private Position Close service — owns the three-tx mainline that
 * closes an `active` Position privately (close/01, Flow 3 in
 * CONTEXT-MAP.md).
 *
 * Conceptually a sub-state cluster of the existing Position lifecycle —
 * same option (a) precedent the Deposit LP Fallback cluster set: the
 * close-flow states (`CLOSING`, `SWAPPING`, `REMIXING`, `CLOSED`, plus
 * the matching `*_FAILED` terminals) live as named variants of the
 * `ExecutionState` union so the existing `canTransition` guard rejects
 * illegal jumps without a parallel state machine.
 *
 * Mainline (relayer-signed, three serial txs — not atomic):
 *   1. `dlmm_withdraw_close` — Executor CPI to Meteora. Claims accrued
 *      fees, removes all liquidity from every bin in the Position's
 *      range, and closes the DLMM Position account. After this lands
 *      the Stealth Wallet holds SOL + (optionally) the other-side
 *      token. State: `active -> CLOSING`.
 *   2. Conditional `dlmm_swap` — only fires when the stealth's
 *      post-close balance of the other-side token exceeds
 *      {@link CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS}. Skipped when the
 *      other side is already SOL or the residual is below the dust
 *      threshold. State: `CLOSING -> SWAPPING -> REMIXING` OR
 *      `CLOSING -> REMIXING` (swap-skip).
 *   3. `mixer.deposit` — relayer-signed deposit of one denomination
 *      worth of SOL into the same-denomination Mixer Pool the original
 *      deposit used. Produces a fresh Commitment the user can later
 *      withdraw to a new recipient. State: `REMIXING -> CLOSED`.
 *
 * Failure handling: each step has a matching `*_FAILED` terminal. The
 * orchestrator transitions to the failure state, records an Activity
 * Record with the corresponding Recovery Guidance entry (one of
 * `close-submission`, `swap-submission`, `remix-submission`), and
 * returns. Recovery from any `*_FAILED` terminal is wired by close/03's
 * user-signed close-recovery flow; until then the recovery guidance
 * surfaces `safeNextStep: contact-support` honestly.
 *
 * Privacy: a bot watching the chain sees only relayer-signed txs — the
 * DLMM Position closes, any non-SOL residual swaps to SOL via Meteora,
 * and one denomination-worth of SOL deposits into the Mixer Pool. The
 * connection between the original deposit and any future withdrawal
 * stays inside the Mixer Pool's Merkle Tree.
 */
import type { PositionRepository } from "./position.repository";
import type { ActivityService } from "./activity.service";
import {
  Position as PositionAggregate,
  type PositionAggregateDeps,
  type PositionResponse,
} from "./position.aggregate";
import { createRecoveryService } from "./recovery.service";
import type { FailureStage, ExecutionState } from "#domain";

/**
 * Threshold below which the conditional `dlmm_swap` step is skipped:
 * if the stealth's post-close balance of the other-side token is at or
 * below 1000 lamports of that token's smallest unit, the residual is
 * documented protocol-level dust (ADR-0003) and left at the Stealth
 * Wallet rather than burning a swap tx on it. Hardcoded as a named
 * constant so future tuning doesn't require code archaeology.
 */
export const CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS = 1000n;

/**
 * close/02 — default slippage tolerance for the conditional `dlmm_swap`
 * leg of the Private Position Close. 50 bps (0.5 %) mirrors the ticket
 * default the UI pre-selects. Out-of-range values are rejected at the
 * schema layer ([{@link MIN_CLOSE_SLIPPAGE_BPS}, {@link MAX_CLOSE_SLIPPAGE_BPS}]).
 */
export const DEFAULT_CLOSE_SLIPPAGE_BPS = 50;
export const MIN_CLOSE_SLIPPAGE_BPS = 10;
export const MAX_CLOSE_SLIPPAGE_BPS = 500;

/**
 * close/02 — options threaded into the close orchestrator from
 * `POST /positions/:id/close`. Both fields are optional so the existing
 * test harness + the route's request body remain backward-compatible
 * with callers that omit the pre-flight quote.
 */
export interface CloseInitiateOptions {
  /**
   * Slippage tolerance for the conditional `dlmm_swap` leg, in bps.
   * Adapters use this to compute `min_amount_out` on the swap ix.
   * Defaults to {@link DEFAULT_CLOSE_SLIPPAGE_BPS} when omitted.
   */
  slippageBps?: number;
  /**
   * Expected SOL output from the swap, in lamports — sourced from the
   * pre-flight `GET /close-quote`. Pairs with `slippageBps` so the
   * adapter can compute `min_amount_out = expectedOut * (1 - bps/10000)`.
   * Optional: when omitted, adapters fall back to legacy behaviour
   * (no min_out protection or refuse — adapter's choice).
   */
  expectedSwapOutLamports?: bigint | null;
}

/**
 * Adapter that performs the actual on-chain work for the close flow.
 * Pulled out as an interface so the service is unit-testable without
 * the live Executor / Mixer clients — the production wiring lives in
 * `position.service.ts` and threads the real clients in.
 *
 * Each method is expected to submit-and-confirm in one shot: returning
 * a signature means the on-chain tx confirmed. A thrown error means
 * the orchestrator should drive the matching `*_FAILED` transition.
 */
export interface CloseOrchestrationAdapter {
  /**
   * Submit `dlmm_withdraw_close` via the Executor. Returns the stealth
   * wallet's post-close residual of the *other-side* token (lamports
   * of that mint's smallest unit). `0n` when the pair is single-sided
   * SOL — the orchestrator uses that to skip the swap step.
   */
  submitWithdrawClose(input: {
    positionId: string;
  }): Promise<{ signature: string; otherSideResidualLamports: bigint }>;

  /**
   * Submit `dlmm_swap` via the Executor for the non-SOL residual.
   * Only invoked when the residual exceeds
   * {@link CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS}.
   *
   * close/02: `slippageBps` + `expectedOutLamports` let the adapter
   * compute `min_amount_out = expectedOutLamports * (1 - bps/10000)` and
   * thread that into the on-chain `dlmm_swap` ix. When the realized
   * swap output falls below `min_amount_out`, the on-chain ix reverts
   * and the orchestrator records `SWAP_FAILED`. `expectedOutLamports`
   * is `null` when no pre-flight quote was taken (e.g. the production
   * close path that didn't go through `GET /close-quote`); adapters
   * may then either skip slippage protection (set min_out = 1, the
   * historical placeholder) or refuse the swap — implementation choice.
   */
  submitSwap(input: {
    positionId: string;
    residualLamports: bigint;
    slippageBps: number;
    expectedOutLamports: bigint | null;
  }): Promise<{ signature: string }>;

  /**
   * Submit the relayer-signed `mixer.deposit` for one denomination's
   * worth of SOL into the same Mixer Pool the original deposit used.
   * Residual below the denomination stays at the Stealth Wallet as
   * documented sub-denom dust (ADR-0003).
   */
  submitMixerDeposit(input: { positionId: string }): Promise<{ signature: string }>;
}

export interface CloseServiceDeps {
  positionRepo: PositionRepository;
  activityService: ActivityService;
  /**
   * Optional — when omitted the service exposes only the
   * `record*` state-machine driver methods. `initiateClose` requires
   * an adapter so the orchestrator has something to call. This split
   * lets the route layer wire a real adapter while unit tests for the
   * pure state-machine behaviour stay adapter-free.
   */
  adapter?: CloseOrchestrationAdapter;
}

export class CloseStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloseStateTransitionError";
  }
}

export function createCloseService(deps: CloseServiceDeps) {
  const { positionRepo, activityService } = deps;
  const recoveryService = createRecoveryService();
  const aggregateDeps: PositionAggregateDeps = {
    positionRepo,
    activityService,
    recoveryService,
  };

  // ── State-machine driver methods ───────────────────────────────────
  // Each method drives a single transition through the close cluster.
  // The aggregate's `advance` validates against `transitions[]` in
  // execution-state-machine.ts, so an illegal jump (e.g.
  // `CLOSING -> CLOSED` skipping `REMIXING`) surfaces as a
  // `CloseStateTransitionError` instead of corrupting state.

  /** Relayer submitted `dlmm_withdraw_close` (active -> CLOSING). */
  async function recordCloseSubmitted(positionId: string): Promise<PositionResponse> {
    const position = await PositionAggregate.load(aggregateDeps, positionId);
    await advance(position, "CLOSING", {
      headline: "Closing position on Meteora",
      detail:
        "Relayer is submitting dlmm_withdraw_close: claim fees, remove liquidity from every bin, close the DLMM Position account.",
      safeNextStep: "wait",
    });
    return position.toResponse();
  }

  /**
   * `dlmm_withdraw_close` confirmed. Routes to `SWAPPING` when a
   * non-SOL residual above the dust threshold remains, or directly to
   * `REMIXING` when SOL is the only thing left.
   */
  async function recordCloseConfirmed(
    positionId: string,
    residualLamports: bigint,
  ): Promise<{ response: PositionResponse; needsSwap: boolean }> {
    const position = await PositionAggregate.load(aggregateDeps, positionId);
    const needsSwap = residualLamports > CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS;
    if (needsSwap) {
      await advance(position, "SWAPPING", {
        headline: "Swapping residual to SOL",
        detail: `Stealth holds ${residualLamports} lamports of the other-side token; routing it through dlmm_swap before the re-mix step.`,
        safeNextStep: "wait",
      });
    } else {
      await advance(position, "REMIXING", {
        headline: "Re-mixing into anonymity set",
        detail:
          residualLamports === 0n
            ? "Single-sided SOL Position; skipping the swap step and going straight to mixer.deposit."
            : `Residual ${residualLamports} lamports is at or below the dust threshold (${CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS}); leaving it at the Stealth Wallet per ADR-0003 and going straight to mixer.deposit.`,
        safeNextStep: "wait",
      });
    }
    return { response: await position.toResponse(), needsSwap };
  }

  /** `dlmm_swap` confirmed (SWAPPING -> REMIXING). */
  async function recordSwapConfirmed(positionId: string): Promise<PositionResponse> {
    const position = await PositionAggregate.load(aggregateDeps, positionId);
    await advance(position, "REMIXING", {
      headline: "Re-mixing into anonymity set",
      detail:
        "Other-side residual swapped to SOL. Relayer is submitting mixer.deposit for one denomination of SOL.",
      safeNextStep: "wait",
    });
    return position.toResponse();
  }

  /** `mixer.deposit` confirmed (REMIXING -> CLOSED, terminal). */
  async function recordRemixConfirmed(positionId: string): Promise<PositionResponse> {
    const position = await PositionAggregate.load(aggregateDeps, positionId);
    await advance(position, "CLOSED", {
      headline: "Closed privately",
      detail:
        "Mixer accepted the fresh Commitment. The DLMM Position is closed, residual non-SOL was swapped, and one denomination of SOL is now a new anonymity-set entry the user can withdraw to a fresh recipient.",
      safeNextStep: "wait",
    });
    return position.toResponse();
  }

  /** `dlmm_withdraw_close` failed (CLOSING -> CLOSE_FAILED, terminal). */
  async function recordCloseFailed(positionId: string, reason: string): Promise<PositionResponse> {
    return failWith(positionId, "CLOSE_FAILED", "close-submission", reason);
  }

  /** `dlmm_swap` failed (SWAPPING -> SWAP_FAILED, terminal). */
  async function recordSwapFailed(positionId: string, reason: string): Promise<PositionResponse> {
    return failWith(positionId, "SWAP_FAILED", "swap-submission", reason);
  }

  /** `mixer.deposit` failed (REMIXING -> REMIX_FAILED, terminal). */
  async function recordRemixFailed(positionId: string, reason: string): Promise<PositionResponse> {
    return failWith(positionId, "REMIX_FAILED", "remix-submission", reason);
  }

  // ── Orchestrator ───────────────────────────────────────────────────

  /**
   * Drive the three (or two, if no swap needed) txs serially. The
   * orchestrator owns the state-machine sequencing; it relies on the
   * adapter for the actual on-chain work. On every step:
   *   - submit + await confirmation via the adapter
   *   - transition via the matching `record*Confirmed` method
   *   - on adapter throw, transition via the matching `record*Failed`
   *     method which records the Activity Record + Recovery Guidance
   *
   * close/02 — `opts.slippageBps` + `opts.expectedSwapOutLamports`
   * thread the user's slippage tolerance through to the swap leg. The
   * adapter turns them into `min_amount_out` on the on-chain `dlmm_swap`
   * ix; a realized output below `min_amount_out` lands in `SWAP_FAILED`.
   * Defaults: 50 bps (0.5 %) slippage, no expected-out (adapter falls
   * back to historical behaviour). See {@link CloseInitiateOptions}.
   */
  async function initiateClose(
    positionId: string,
    opts: CloseInitiateOptions = {},
  ): Promise<PositionResponse> {
    const adapter = deps.adapter;
    if (!adapter) {
      throw new Error(
        "createCloseService was constructed without an adapter; initiateClose is unavailable. Wire a CloseOrchestrationAdapter in the service composition root.",
      );
    }

    // Precondition: only `active` Positions can enter the close flow.
    // Loading once here gives us a stable, typed error path; the
    // `advance(CLOSING)` inside `recordCloseSubmitted` re-checks the
    // guard, so a race with another caller still fails closed.
    const startPosition = await PositionAggregate.load(aggregateDeps, positionId);
    if (startPosition.state !== "active") {
      throw new CloseStateTransitionError(
        `Position ${positionId} must be active to initiate close, got ${startPosition.state}.`,
      );
    }

    // Step 1: dlmm_withdraw_close
    await recordCloseSubmitted(positionId);
    let withdrawClose: Awaited<ReturnType<CloseOrchestrationAdapter["submitWithdrawClose"]>>;
    try {
      withdrawClose = await adapter.submitWithdrawClose({ positionId });
    } catch (err) {
      return recordCloseFailed(positionId, formatErr(err));
    }

    // Step 2 (conditional): dlmm_swap
    const { needsSwap } = await recordCloseConfirmed(
      positionId,
      withdrawClose.otherSideResidualLamports,
    );
    if (needsSwap) {
      try {
        await adapter.submitSwap({
          positionId,
          residualLamports: withdrawClose.otherSideResidualLamports,
          slippageBps: opts.slippageBps ?? DEFAULT_CLOSE_SLIPPAGE_BPS,
          expectedOutLamports: opts.expectedSwapOutLamports ?? null,
        });
      } catch (err) {
        return recordSwapFailed(positionId, formatErr(err));
      }
      await recordSwapConfirmed(positionId);
    }

    // Step 3: mixer.deposit
    try {
      await adapter.submitMixerDeposit({ positionId });
    } catch (err) {
      return recordRemixFailed(positionId, formatErr(err));
    }
    return recordRemixConfirmed(positionId);
  }

  async function failWith(
    positionId: string,
    target: ExecutionState,
    stage: FailureStage,
    reason: string,
  ): Promise<PositionResponse> {
    const position = await PositionAggregate.load(aggregateDeps, positionId);
    const guidance = recoveryService.getRecoveryGuidance({
      failureStage: stage,
      mode: position.mode,
    });
    await advance(position, target, {
      headline: guidance?.headline ?? `${target} reached`,
      detail: `${reason} ${guidance?.message ?? ""}`.trim(),
      safeNextStep: guidance?.safeNextStep ?? "contact-support",
    });
    // Stamp the failure stage on the execution session so the recovery
    // panel renders the right catalog entry. Reuse the position
    // repo's session update directly — `advance` already moved the
    // session to the target state; we just need to add the stage.
    await positionRepo.updateExecutionSession(positionId, target, stage);
    return PositionAggregate.load(aggregateDeps, positionId).then((p) => p.toResponse());
  }

  return {
    initiateClose,
    recordCloseSubmitted,
    recordCloseConfirmed,
    recordSwapConfirmed,
    recordRemixConfirmed,
    recordCloseFailed,
    recordSwapFailed,
    recordRemixFailed,
  };
}

export type CloseService = ReturnType<typeof createCloseService>;

/**
 * Wrapper around `position.advance` that maps the bare `Error` thrown
 * by the state-machine guard into a typed `CloseStateTransitionError`.
 * Routes / callers can map this to a 409 without leaking the raw guard
 * string. Mirrors `position.deposit-lp.service`'s `advance` helper —
 * same shape, separate error type to keep the two clusters' "wrong
 * state" surfaces independently observable.
 */
async function advance(
  position: PositionAggregate,
  target: Parameters<PositionAggregate["advance"]>[0],
  activity: Parameters<PositionAggregate["advance"]>[1],
): Promise<void> {
  try {
    await position.advance(target, activity);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid state transition")) {
      throw new CloseStateTransitionError(err.message);
    }
    throw err;
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Octora stopped safely.";
}
