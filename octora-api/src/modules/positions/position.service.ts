/**
 * Position service composition root.
 *
 * Delegates each lifecycle stage to a focused sibling service:
 *   - `position.intent.service`     — draft + read
 *   - `position.execution.service`  — signed → indexing
 *   - `position.claim.service`      — active → completed (claim / withdraw)
 *
 * Shared aggregate (state transitions + failure recording + response
 * shape) lives in `position.aggregate`; the lifecycle files use it
 * directly so each stays focused on one stage.
 */
import { MockPrivacyAdapter, type PrivacyAdapter } from "#modules/execution/adapters";
import { createMockMeteoraExecutor, type MeteoraExecutor } from "#modules/execution/clients";
import { createIndexerService, type PositionIndexer } from "#modules/indexer";
import type { ReconciliationRepository } from "#modules/indexer/indexer.repository";
import { PositionNotFoundError, UnsupportedPositionActionError } from "#common/errors";
import type { BetaCapsConfig } from "#common/config";

import type { PositionRepository } from "./position.repository";
import type { ActivityRepository } from "./activity.repository";
import { createActivityService } from "./activity.service";
import { createRecoveryService } from "./recovery.service";
import {
  createDraftPositionIntent,
  getPosition,
  type CreateDraftPositionIntentInput,
} from "./position.intent.service";
import {
  executeSignedIntent,
  type ExecuteSignedIntentInput,
} from "./position.execution.service";
import {
  claimPosition,
  withdrawClosePosition,
  type ClaimPositionInput,
  type WithdrawClosePositionInput,
} from "./position.claim.service";
import {
  createDepositLpService,
  type RecordDepositInput,
  DepositLpStateTransitionError,
} from "./position.deposit-lp.service";
import {
  InvalidRecoveryStateError,
  InvalidCloseRecoveryStateError,
  recoverFundsUserSigned,
  recoverCloseUserSigned,
  type RecoverFundsUserSignedInput,
  type RecoverCloseUserSignedInput,
  type CloseRecoveryAction,
} from "./position.recover.service";
import {
  createCloseService,
  CloseStateTransitionError,
  DEFAULT_CLOSE_SLIPPAGE_BPS,
  type CloseOrchestrationAdapter,
  type CloseInitiateOptions,
} from "./position.close.service";
import {
  createCloseQuoteService,
  type CloseQuoteAdapter,
  type CloseQuoteResponse,
} from "./position.close-quote.service";
import {
  buildCloseRecoveryTx,
  type CloseBuilderInput,
  type CloseBuilderResult,
  type CloseRecoveryLeg,
  type CloseRecoveryLegBuilders,
} from "./position.close-builder.service";
import type { SolanaChain } from "#common/solana/chain";
import {
  claimMidPositionFees,
  remixClaimedFees,
  MidPositionFeeClaimStateError,
  FeeClaimBelowThresholdError,
  type ClaimMidPositionFeesInput,
  type ClaimMidPositionFeesResult,
  type RemixClaimedFeesInput,
  type RemixClaimedFeesResult,
} from "./position.fee-claim.service";
import {
  BetaCapExceededError,
  DEFAULT_BETA_CAPS,
  type PositionResponse,
} from "./position.aggregate";

export {
  BetaCapExceededError,
  PositionNotFoundError,
  UnsupportedPositionActionError,
  DepositLpStateTransitionError,
  InvalidRecoveryStateError,
  InvalidCloseRecoveryStateError,
  CloseStateTransitionError,
  MidPositionFeeClaimStateError,
  FeeClaimBelowThresholdError,
  // close/02 — re-exported so the controller's schema/route handlers
  // (and tests) can reference the canonical slippage default.
  DEFAULT_CLOSE_SLIPPAGE_BPS,
};
export type { CloseOrchestrationAdapter, CloseInitiateOptions };
// close/02 — exported so app.ts + tests can wire a CloseQuoteAdapter.
export type { CloseQuoteAdapter, CloseQuoteResponse };
// close/06 — re-exported so the controller + tests can name the leg union.
export type { CloseRecoveryLeg, CloseBuilderInput, CloseBuilderResult };
// close/06 production wiring — per-leg ix builders that swap in for
// the placeholder shape when the close-builder route is fully wired.
export type { CloseRecoveryLegBuilders };
export type { PositionResponse };
export type {
  CreateDraftPositionIntentInput,
  ExecuteSignedIntentInput,
  ClaimPositionInput,
  WithdrawClosePositionInput,
  RecordDepositInput,
  RecoverFundsUserSignedInput,
  RecoverCloseUserSignedInput,
  CloseRecoveryAction,
  ClaimMidPositionFeesInput,
  ClaimMidPositionFeesResult,
  RemixClaimedFeesInput,
  RemixClaimedFeesResult,
};
export type {
  PositionSessionState,
  PositionSnapshot,
} from "./position.aggregate";

export interface PositionServiceDependencies {
  positionRepo: PositionRepository;
  activityRepo: ActivityRepository;
  reconciliationRepo?: ReconciliationRepository;
  privacyAdapter?: PrivacyAdapter;
  meteoraExecutor?: MeteoraExecutor;
  positionIndexer?: PositionIndexer;
  recoveryService?: ReturnType<typeof createRecoveryService>;
  /**
   * Beta cohort caps. Defaults to {@link DEFAULT_BETA_CAPS} so existing
   * tests that don't care about caps don't have to pass a config.
   */
  betaCaps?: BetaCapsConfig;
  /**
   * Adapter for the Private Position Close orchestrator (close/01).
   * Optional — when omitted, `closePosition` rejects with a typed
   * error so production deployments must wire a real adapter. Tests
   * supply an in-memory adapter to exercise the orchestrator.
   */
  closeAdapter?: CloseOrchestrationAdapter;
  /**
   * close/02 — Adapter for the pre-flight `GET /close-quote` reads.
   * Same scope-down as `closeAdapter`: optional, so production
   * deployments without a live wiring reject cleanly while tests
   * inject an in-memory adapter to exercise the route.
   */
  closeQuoteAdapter?: CloseQuoteAdapter;
  /**
   * close/06 — Solana chain handle used by the close-builder service
   * to fetch a fresh blockhash for the unsigned recovery txs the
   * browser stealth-signs. Optional: when omitted, the
   * `closeBuilder` endpoint rejects cleanly so production deployments
   * must wire a real chain.
   */
  closeBuilderChain?: SolanaChain;
  /**
   * close/06 production wiring — per-leg ix builders. When wired, each
   * leg of the close-recovery flow emits real on-chain ixs
   * (`dlmm_withdraw_close`, `dlmm_swap`, `mixer.deposit`); when
   * omitted, the placeholder zero-lamport transfer keeps the unsigned
   * tx structurally valid for the test path. Same scope-down as
   * `closeAdapter` / `closeQuoteAdapter`: production deployments
   * wire this; tests opt in per-case.
   */
  closeBuilderLegBuilders?: CloseRecoveryLegBuilders;
}

export function createPositionService(deps: PositionServiceDependencies) {
  const positionRepo = deps.positionRepo;
  const activityRepo = deps.activityRepo;
  const activityService = createActivityService(activityRepo);
  const privacyAdapter = deps.privacyAdapter ?? new MockPrivacyAdapter();
  const meteoraExecutor = deps.meteoraExecutor ?? createMockMeteoraExecutor();
  const positionIndexer =
    deps.positionIndexer ?? createIndexerService({ store: deps.reconciliationRepo! });
  const recoveryService = deps.recoveryService ?? createRecoveryService();
  const betaCaps = deps.betaCaps ?? DEFAULT_BETA_CAPS;
  const depositLp = createDepositLpService({ positionRepo, activityService });
  const closeFlow = createCloseService({
    positionRepo,
    activityService,
    adapter: deps.closeAdapter,
  });
  // close/02 — quote service. Separate from `closeFlow` because the
  // quote is read-only + adapter-shaped differently (no state-machine
  // driver methods). Same scope-down: omitting the adapter makes the
  // route reject cleanly in production.
  const closeQuote = createCloseQuoteService({
    positionRepo,
    adapter: deps.closeQuoteAdapter,
  });

  return {
    createDraftPositionIntent(input: CreateDraftPositionIntentInput): Promise<PositionResponse> {
      return createDraftPositionIntent(positionRepo, activityService, betaCaps, input);
    },
    // ── Deposit LP Fallback state-machine driver ──────────────────────
    // Each method transitions the Position through a single Deposit LP
    // Fallback sub-state. The aggregate's `advance` validates against
    // `transitions[]` in execution-state-machine.ts, so an illegal jump
    // (e.g. `DEPOSITED -> LP_DONE` skipping `LP_PENDING`) surfaces as a
    // `DepositLpStateTransitionError` instead of corrupting state.
    recordDeposit(input: RecordDepositInput): Promise<PositionResponse> {
      return depositLp.recordDeposit(input);
    },
    markLpPending(positionId: string): Promise<PositionResponse> {
      return depositLp.markLpPending(positionId);
    },
    markLpDone(positionId: string): Promise<PositionResponse> {
      return depositLp.markLpDone(positionId);
    },
    markLpFailed(positionId: string, reason: string): Promise<PositionResponse> {
      return depositLp.markLpFailed(positionId, reason);
    },
    retryLp(positionId: string): Promise<PositionResponse> {
      return depositLp.retryLp(positionId);
    },
    parkLp(positionId: string): Promise<PositionResponse> {
      return depositLp.parkLp(positionId);
    },
    markWithdrawn(positionId: string): Promise<PositionResponse> {
      return depositLp.markWithdrawn(positionId);
    },
    /**
     * dust/04 entry point — the user broke the relayer-offline glass,
     * signed `mixer.withdraw` themselves, broadcast it directly to RPC,
     * and is now reporting the on-chain outcome so the orchestration
     * state matches. Throws `InvalidRecoveryStateError` when the
     * Position is not in `LP_FAILED` or `PARKED`. See
     * `position.recover.service` for the privacy + ADR-0002/0004
     * rationale.
     */
    recoverFundsUserSigned(input: RecoverFundsUserSignedInput): Promise<PositionResponse> {
      return recoverFundsUserSigned(positionRepo, activityService, input);
    },
    executeSignedIntent(input: ExecuteSignedIntentInput): Promise<PositionResponse> {
      return executeSignedIntent(
        positionRepo,
        activityService,
        privacyAdapter,
        meteoraExecutor,
        positionIndexer,
        recoveryService,
        input,
      );
    },
    claimPosition(input: ClaimPositionInput): Promise<PositionResponse> {
      return claimPosition(positionRepo, activityService, privacyAdapter, meteoraExecutor, input);
    },
    withdrawClosePosition(input: WithdrawClosePositionInput): Promise<PositionResponse> {
      return withdrawClosePosition(positionRepo, activityService, privacyAdapter, meteoraExecutor, input);
    },
    /**
     * close/01 entry point — drive an `active` Position through the
     * three-tx Private Position Close mainline. Throws
     * `CloseStateTransitionError` from a non-`active` source state.
     *
     * close/02 — `opts.slippageBps` + `opts.expectedSwapOutLamports`
     * thread the user's slippage tolerance through to the swap leg.
     * Both are optional so callers that bypass the close-quote
     * pre-flight (legacy / tests) still work.
     */
    closePosition(
      positionId: string,
      opts: CloseInitiateOptions = {},
    ): Promise<PositionResponse> {
      return closeFlow.initiateClose(positionId, opts);
    },
    /**
     * close/02 — pre-flight `GET /close-quote` entry point. Reads
     * on-chain DLMM state (via the wired `CloseQuoteAdapter`), runs
     * the close/04 mint precheck, and returns the structured preview
     * shape the close confirmation modal renders.
     */
    closeQuote(positionId: string): Promise<CloseQuoteResponse> {
      return closeQuote.quote(positionId);
    },
    // close/03 — user-signed close-recovery. Browser already broadcast
    // the recovery tx(s) directly via RPC; this entry point records
    // the audit row and drives `*_FAILED → {CLOSED, WITHDRAWN}` via
    // the close service. Throws `InvalidCloseRecoveryStateError` from
    // a non-`*_FAILED` source state.
    recoverCloseUserSigned(input: RecoverCloseUserSignedInput): Promise<PositionResponse> {
      return recoverCloseUserSigned(positionRepo, activityService, input);
    },
    /**
     * close/06 — assemble an unsigned close-recovery tx for the
     * requested leg. The browser stealth-keypair signs and broadcasts
     * directly to RPC; this service never signs and never submits, so
     * the relayer-offline contract from close/03 still holds. Throws
     * when no chain is wired (production startup must inject one).
     */
    buildCloseRecoveryTx(input: CloseBuilderInput): Promise<CloseBuilderResult> {
      if (!deps.closeBuilderChain) {
        throw new Error(
          "close-builder is not wired: pass a `closeBuilderChain` to createPositionService.",
        );
      }
      return buildCloseRecoveryTx(
        { chain: deps.closeBuilderChain, legBuilders: deps.closeBuilderLegBuilders },
        input,
      );
    },
    /**
     * close/05 — mid-position fee claim. Builds + relayer-signs
     * `dlmm_claim_fees`, lands fees in the Stealth Wallet, emits an
     * Activity Record at `active`. Position state does NOT change.
     */
    claimMidPositionFees(input: ClaimMidPositionFeesInput): Promise<ClaimMidPositionFeesResult> {
      return claimMidPositionFees(positionRepo, activityService, meteoraExecutor, input);
    },
    /**
     * close/05 — re-mix the claimed SOL. Wraps the existing Flow 1
     * `mixer.deposit` machinery and tags the Activity Record with
     * `source: "fee-claim"`. The deposit ix is built via the existing
     * /mixer/deposit endpoint; this endpoint records the outcome so
     * the audit trail links the claim → re-mix → fresh Commitment.
     */
    remixClaimedFees(input: RemixClaimedFeesInput): Promise<RemixClaimedFeesResult> {
      return remixClaimedFees(positionRepo, activityService, input);
    },
    getPosition(positionId: string): Promise<PositionResponse> {
      return getPosition(positionRepo, activityService, positionIndexer, positionId);
    },
  };
}
