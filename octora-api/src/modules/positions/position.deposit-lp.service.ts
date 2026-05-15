/**
 * Deposit LP Fallback service — owns the two-phase `Private Deposit ->
 * Position Open` flow that ADR-0004 makes the **primary path** for
 * Octora's `add-liquidity` action.
 *
 * Conceptually a sub-state cluster of the existing Position lifecycle
 * (see CONTEXT.md, "Deposit LP Fallback State"). The state names are
 * variants of `ExecutionState` (`DEPOSITED`, `LP_PENDING`, `LP_FAILED`,
 * `LP_RETRIED`, `PARKED`, `WITHDRAWN`, `LP_DONE`) — option (a) from the
 * dust/03 ticket — but the glossary names them as a sub-state cluster
 * for the existing `funding-partial` failure stage (option (b)). The two
 * framings reconcile here: variants live in the union, the guard rejects
 * any path outside the cluster, and the persistence side-effects
 * (`clearDepositIntent`) are wired only on the cluster's terminal states.
 *
 * Phases:
 *   1. `recordDeposit` — `mixer.deposit` confirmed → backend transitions
 *      the Position to `DEPOSITED` and persists the intent
 *      (`{commitment, intendedPool, denom, expiresAt}` keyed by
 *      `nullifierHash`).
 *   2. `markLpPending` — frontend submits user-signed `withdraw +
 *      add_liquidity`; the Position moves to `LP_PENDING`.
 *   3. `markLpDone` — Position NFT minted → `LP_DONE` (terminal),
 *      persisted intent cleared.
 *   4. `markLpFailed` — tx revert / timeout → `LP_FAILED`; user picks
 *      retry / park / withdraw from the recovery panel.
 *   5. `retryLp` — re-arms the LP attempt via `LP_RETRIED`.
 *   6. `parkLp` — `PARKED`; intent stays persisted so a later
 *      "Resume in pool" CTA can resume.
 *   7. `markWithdrawn` — `WITHDRAWN` (terminal), persisted intent
 *      cleared. TODO(dust/04): the user-signed Recover Funds tx is
 *      wired in dust/04; this method only flips the orchestration state
 *      once the relayer / front-end reports the recovery tx landed.
 */
import type { Position } from "./position.aggregate";
import type { PositionAggregateDeps, PositionResponse } from "./position.aggregate";
import { Position as PositionAggregate } from "./position.aggregate";
import type { PositionRepository } from "./position.repository";
import type { ActivityService } from "./activity.service";
import { createRecoveryService } from "./recovery.service";

export interface RecordDepositInput {
  positionId: string;
  /**
   * Nullifier hash from the user's mixer deposit. The user holds the
   * preimage off-chain (custodial-less). Backend only sees the hash, so
   * "stuck" funds are a UX gap (the user can always reconstruct the
   * preimage from their Encrypted Seed), not a protocol gap.
   */
  nullifierHash: string;
  /** Commitment posted to the on-chain Mixer Pool. */
  commitment: string;
  /** Pool slug / address the user intends to LP into. */
  intendedPool: string;
  /** Denomination in lamports (single-sided SOL on launch — MVP scope). */
  denomLamports: string;
  /** Absolute expiry instant; default 24h from now if not provided. */
  expiresAtIso?: string;
}

export interface DepositLpServiceDeps {
  positionRepo: PositionRepository;
  activityService: ActivityService;
}

export class DepositLpStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepositLpStateTransitionError";
  }
}

/** Default persisted-intent TTL when the caller doesn't supply `expiresAtIso`. */
const DEFAULT_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

export function createDepositLpService(deps: DepositLpServiceDeps) {
  const { positionRepo, activityService } = deps;
  const recoveryService = createRecoveryService();
  const aggregateDeps: PositionAggregateDeps = {
    positionRepo,
    activityService,
    recoveryService,
  };

  /** `mixer.deposit` confirmed → `DEPOSITED` + persist intent. */
  async function recordDeposit(input: RecordDepositInput): Promise<PositionResponse> {
    const position = await PositionAggregate.load(aggregateDeps, input.positionId);

    // Persist *first*, then transition. If the transition guard rejects
    // (caller is in a non-permitted state), the persisted row is the
    // only meaningful evidence the deposit landed — without it the user
    // would have no way to find their funds.
    await positionRepo.persistDepositIntent({
      nullifierHash: input.nullifierHash,
      positionId: input.positionId,
      commitment: input.commitment,
      intendedPool: input.intendedPool,
      denom: input.denomLamports,
      expiresAt: new Date(input.expiresAtIso ?? new Date(Date.now() + DEFAULT_INTENT_TTL_MS).toISOString()),
    });

    await advance(position, "DEPOSITED", {
      headline: "Deposit confirmed",
      detail: `Mixer accepted the deposit. Adding liquidity to ${input.intendedPool} next.`,
      safeNextStep: "wait",
    });

    return position.toResponse();
  }

  /** User signed the `withdraw + add_liquidity` tx → `LP_PENDING`. */
  async function markLpPending(positionId: string): Promise<PositionResponse> {
    const position = await PositionAggregate.load(aggregateDeps, positionId);
    await advance(position, "LP_PENDING", {
      headline: "Adding liquidity",
      detail: "Stealth wallet is submitting withdraw + add_liquidity to Meteora.",
      safeNextStep: "wait",
    });
    return position.toResponse();
  }

  /** DLMM Position NFT minted → `LP_DONE` (terminal; clears intent). */
  async function markLpDone(positionId: string): Promise<PositionResponse> {
    const position = await PositionAggregate.load(aggregateDeps, positionId);
    await advance(position, "LP_DONE", {
      headline: "Position active",
      detail: "DLMM Position minted to the Stealth Wallet. Persisted deposit intent cleared.",
      safeNextStep: "wait",
    });
    return position.toResponse();
  }

  /** `withdraw + add_liquidity` reverted or timed out → `LP_FAILED`. */
  async function markLpFailed(positionId: string, reason: string): Promise<PositionResponse> {
    const position = await PositionAggregate.load(aggregateDeps, positionId);
    await advance(position, "LP_FAILED", {
      headline: "Add liquidity failed",
      detail: `${reason} Retry to keep the private route, park for later, or recover funds (user-signed, breaks unlinkability).`,
      safeNextStep: "retry",
    });
    return position.toResponse();
  }

  /** User clicked **Retry private LP** from the recovery panel. */
  async function retryLp(positionId: string): Promise<PositionResponse> {
    const position = await PositionAggregate.load(aggregateDeps, positionId);
    await advance(position, "LP_RETRIED", {
      headline: "Retrying add liquidity",
      detail: "Re-attempting the user-signed withdraw + add_liquidity. Stealth Wallet identity preserved.",
      safeNextStep: "wait",
    });
    return position.toResponse();
  }

  /** User clicked **Park for later** from the recovery panel. */
  async function parkLp(positionId: string): Promise<PositionResponse> {
    const position = await PositionAggregate.load(aggregateDeps, positionId);
    await advance(position, "PARKED", {
      headline: "Parked for later",
      detail: "Funds remain claimable via the persisted deposit intent. Resume from the pool when ready.",
      safeNextStep: "wait",
    });
    return position.toResponse();
  }

  /**
   * User-signed Recover Funds path landed → `WITHDRAWN` (terminal;
   * clears intent).
   *
   * TODO(dust/04): wired by dust/04 — the actual user-signed withdraw
   * transaction (Stealth Wallet → main wallet) is built and submitted in
   * that ticket. This method exists today so dust/04 has a typed entry
   * point; it asserts the state-machine guard permits the transition,
   * which is all dust/03 is responsible for.
   */
  async function markWithdrawn(positionId: string): Promise<PositionResponse> {
    const position = await PositionAggregate.load(aggregateDeps, positionId);
    await advance(position, "WITHDRAWN", {
      headline: "Recovered",
      detail:
        "User-signed Recover Funds transaction landed. Origin wallet is now linkable to this Position's destination on-chain; persisted deposit intent cleared.",
      safeNextStep: "wait",
    });
    return position.toResponse();
  }

  return {
    recordDeposit,
    markLpPending,
    markLpDone,
    markLpFailed,
    retryLp,
    parkLp,
    markWithdrawn,
  };
}

export type DepositLpService = ReturnType<typeof createDepositLpService>;

/**
 * Wrapper around `position.advance` that maps the bare `Error` thrown by
 * the state-machine guard into a typed `DepositLpStateTransitionError`.
 * Routes / callers can map this to a 409 without leaking the raw guard
 * string.
 */
async function advance(
  position: Position,
  target: Parameters<Position["advance"]>[0],
  activity: Parameters<Position["advance"]>[1],
): Promise<void> {
  try {
    await position.advance(target, activity);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid state transition")) {
      throw new DepositLpStateTransitionError(err.message);
    }
    throw err;
  }
}
