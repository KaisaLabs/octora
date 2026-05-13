import { Connection, type Commitment } from "@solana/web3.js";

import type { PositionRow, PositionRepository } from "#modules/positions/position.repository";
import type { ActivityService } from "#modules/positions/activity.service";
import type { PositionIndexer } from "#modules/indexer";
import type { ReconciliationRepository } from "#modules/indexer/indexer.repository";
import type { ExecutionState, FailureStage, PositionAction } from "#domain";

/**
 * Background reconciler for stuck positions (P1-29).
 *
 * The position state machine has seven stages where a CPI failure or
 * indexer lag can leave a position in an in-progress state forever
 * unless someone (or something) re-checks. Without this worker that
 * "someone" was a human reading the README — which is exactly the
 * "manual recovery" the audit flagged as a P1 blocker.
 *
 * Each tick (default 30s):
 *
 *   1. **executing_on_meteora > 5min** — query the on-chain signature
 *      status. Confirmed/finalized → advance to `indexing`. Failed
 *      (signature err present, or signature missing past 5 min) →
 *      advance to `failed` with stage `venue-confirmation`. Still
 *      processing → leave alone, retry next tick.
 *
 *   2. **indexing > 2min** — re-run the indexer reconciler. If it
 *      reports `active`, advance the position. Otherwise log and
 *      retry next tick.
 *
 *   3. **failed since last tick** — fire a single capture per newly
 *      failed position via the Sentry hook, so on-call gets paged
 *      exactly once per failure regardless of poll cadence.
 *
 * Bounds:
 *   - Each query is `LIMIT 50` so a runaway dataset can't stall the
 *     loop.
 *   - The signature-status check is the only RPC call; if the RPC is
 *     down the worker logs and retries — the indexer fall-back path
 *     handles it on the next tick.
 *   - Errors are caught per-position so one bad row never aborts the
 *     whole batch.
 */

const DEFAULT_INTERVAL_MS = 30_000;
const EXECUTING_STUCK_AFTER_MS = 5 * 60 * 1000;
const INDEXING_STUCK_AFTER_MS = 2 * 60 * 1000;
const SCAN_BATCH_LIMIT = 50;

/**
 * Confirmation level the worker treats as "tx landed and we trust the
 * outcome." Mirrors the relayer's submission commitment so we don't
 * advance positions on a slot that could still reorg.
 */
const RECOVERY_COMMITMENT: Commitment = "confirmed";

export interface RecoveryWorkerDeps {
  positionRepo: PositionRepository;
  activityService: ActivityService;
  positionIndexer: PositionIndexer;
  /** RPC for signature-status checks. Same provider the relayer uses. */
  connection: Connection;
  /** Reconciliation store — used to read signatures stamped by the executor path. */
  reconciliationRepo: ReconciliationRepository;
  /** Optional Sentry-shaped capture hook. No-op when null. */
  captureException?: (err: unknown, ctx?: Record<string, unknown>) => void;
  /** Logger. Defaults to console.log. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface RecoveryWorkerOptions {
  /** Tick interval. Default 30s. */
  intervalMs?: number;
}

export interface RecoveryWorker {
  /** Start polling. Returns immediately; the timer keeps the process alive only if you don't call `unref` (we don't). */
  start(): void;
  /** Stop polling and clear the timer. Idempotent. */
  stop(): void;
  /** Run a single tick synchronously — exposed for tests. */
  tick(now?: Date): Promise<RecoveryTickResult>;
}

export interface RecoveryTickResult {
  executingChecked: number;
  executingAdvanced: number;
  executingFailed: number;
  indexingChecked: number;
  indexingAdvanced: number;
  failuresAlerted: number;
}

const FAILURE_STAGE_VENUE: FailureStage = "venue-confirmation";

export function createRecoveryWorker(
  deps: RecoveryWorkerDeps,
  options: RecoveryWorkerOptions = {},
): RecoveryWorker {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = deps.log ?? ((msg: string, ctx?: Record<string, unknown>) => {
    // eslint-disable-next-line no-console
    if (ctx) console.log(msg, ctx);
    else console.log(msg);
  });
  const capture = deps.captureException ?? (() => {});

  /**
   * Track the most recent failure scan boundary. On each tick we look
   * for failures with `updatedAt >= lastFailureScan` so newly-failed
   * positions get exactly one Sentry hit, even if the position lingers
   * in the failed state across many polls.
   *
   * Init backdated by `intervalMs * 4` so a worker boot doesn't lose
   * the alert on a position that failed during a brief outage. Worst
   * case: the very first tick after boot pages on a few stragglers
   * that already alerted in a previous instance — better to double-
   * page than miss a real failure.
   */
  let lastFailureScan = new Date(Date.now() - intervalMs * 4);
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick(now: Date = new Date()): Promise<RecoveryTickResult> {
    const result: RecoveryTickResult = {
      executingChecked: 0,
      executingAdvanced: 0,
      executingFailed: 0,
      indexingChecked: 0,
      indexingAdvanced: 0,
      failuresAlerted: 0,
    };

    try {
      // 1. executing_on_meteora older than 5 min.
      const execCutoff = new Date(now.getTime() - EXECUTING_STUCK_AFTER_MS);
      const stuckExecuting = await deps.positionRepo.findStuckPositions(
        "executing_on_meteora",
        execCutoff,
        SCAN_BATCH_LIMIT,
      );
      result.executingChecked = stuckExecuting.length;

      for (const position of stuckExecuting) {
        try {
          const decision = await checkVenueSignature(deps, position, now);
          if (decision === "confirmed") {
            await advanceTo(deps, position, "indexing");
            result.executingAdvanced++;
          } else if (decision === "failed") {
            await failPosition(deps, position, FAILURE_STAGE_VENUE);
            result.executingFailed++;
          }
          // "pending" → leave it; check again next tick.
        } catch (err) {
          log("recovery: error advancing executing position", {
            positionId: position.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 2. indexing older than 2 min.
      const idxCutoff = new Date(now.getTime() - INDEXING_STUCK_AFTER_MS);
      const stuckIndexing = await deps.positionRepo.findStuckPositions(
        "indexing",
        idxCutoff,
        SCAN_BATCH_LIMIT,
      );
      result.indexingChecked = stuckIndexing.length;

      for (const position of stuckIndexing) {
        try {
          const reconciled = await deps.positionIndexer.reconcile(position.id);
          if (reconciled.state === "active") {
            await advanceTo(deps, position, "active");
            result.indexingAdvanced++;
          }
        } catch (err) {
          log("recovery: error reconciling indexing position", {
            positionId: position.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // 3. fan-out alert for newly-failed positions.
      const newFailures = await deps.positionRepo.findRecentlyFailed(
        lastFailureScan,
        SCAN_BATCH_LIMIT,
      );
      for (const failure of newFailures) {
        const err = new Error(
          `Position ${failure.id} entered failed state (action=${failure.action}, ` +
            `wallet=${failure.walletAddress})`,
        );
        capture(err, {
          positionId: failure.id,
          walletAddress: failure.walletAddress,
          action: failure.action,
          poolSlug: failure.poolSlug,
        });
        result.failuresAlerted++;
      }
      lastFailureScan = now;

      log("recovery: tick", { ...result });
    } catch (err) {
      log("recovery: tick aborted with unexpected error", {
        error: err instanceof Error ? err.message : String(err),
      });
      capture(err, { context: "recovery-worker-tick" });
    }

    return result;
  }

  return {
    tick,
    start() {
      if (timer || running) return;
      running = true;
      const loop = async () => {
        if (!running) return;
        try {
          await tick();
        } finally {
          if (running) timer = setTimeout(loop, intervalMs);
        }
      };
      // First tick happens after `intervalMs`, not at boot — gives the
      // app time to register routes / repos before the worker starts
      // poking the DB.
      timer = setTimeout(loop, intervalMs);
    },
    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

type VenueDecision = "confirmed" | "failed" | "pending";

async function checkVenueSignature(
  deps: RecoveryWorkerDeps,
  position: PositionRow,
  now: Date,
): Promise<VenueDecision> {
  const reconciliation = await deps.reconciliationRepo.load(position.id);

  // No signature stamped yet AND we're already 5 min past last update:
  // the venue submission silently dropped. Fail closed.
  if (!reconciliation?.signature) {
    const ageMs = now.getTime() - position.updatedAt.getTime();
    return ageMs > EXECUTING_STUCK_AFTER_MS ? "failed" : "pending";
  }

  const status = await deps.connection.getSignatureStatus(reconciliation.signature, {
    searchTransactionHistory: true,
  });

  const value = status?.value ?? null;
  if (!value) {
    // RPC returns null when the sig has dropped from cache and the
    // search-history flag couldn't find it. Treat as failed once we're
    // past the stuck threshold; conservative on shorter ages.
    const ageMs = now.getTime() - position.updatedAt.getTime();
    return ageMs > EXECUTING_STUCK_AFTER_MS * 2 ? "failed" : "pending";
  }
  if (value.err) return "failed";
  if (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized") {
    return "confirmed";
  }
  if (value.confirmationStatus === "processed") {
    // Submitted but not confirmed yet — give it another tick before we
    // count it. RECOVERY_COMMITMENT is "confirmed" so we don't advance
    // on a slot that could still reorg.
    return "pending";
  }
  return "pending";
}

async function advanceTo(
  deps: RecoveryWorkerDeps,
  position: PositionRow,
  to: ExecutionState,
): Promise<void> {
  const updated = await deps.positionRepo.updatePositionState(position.id, to);
  await deps.positionRepo.updateExecutionSession(position.id, to);
  await deps.activityService.record(
    updated,
    to,
    `Recovered position into ${to}`,
    `Recovery worker advanced ${position.id} from ${position.state} to ${to}.`,
    "wait",
  );
}

async function failPosition(
  deps: RecoveryWorkerDeps,
  position: PositionRow,
  stage: FailureStage,
): Promise<void> {
  const updated = await deps.positionRepo.updatePositionState(position.id, "failed");
  await deps.positionRepo.updateExecutionSession(position.id, "failed", stage);
  await deps.activityService.record(
    updated,
    "failed",
    "Recovery flagged position as failed",
    `Recovery worker exhausted retries on ${position.action as PositionAction} (stage: ${stage}).`,
    "contact-support",
  );
}
