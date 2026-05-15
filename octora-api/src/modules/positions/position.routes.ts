import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

import { rateLimitHook, walletThenIpKey, type RateLimiterFactory } from '#common/ratelimit'

import { createPositionController, type PositionControllerDeps } from './position.controller'
import {
  createIntentSchema,
  executeIntentSchema,
  positionParamsSchema,
  recordDepositSchema,
  lpFailedSchema,
  recoverFundsSchema,
  remixClaimedFeesSchema,
} from './position.schema'

interface CreateIntentBody {
  action: 'add-liquidity' | 'claim' | 'withdraw-close'
  amount: string
  pool: string
  mode: 'standard' | 'fast-private'
}

interface ExecuteIntentBody {
  signedMessage: string
}

interface PositionParams {
  positionId: string
}

interface RecordDepositBody {
  nullifierHash: string
  commitment: string
  intendedPool: string
  denomLamports: string
  expiresAtIso?: string
}

interface LpFailedBody {
  reason?: string
}

interface RecoverFundsBody {
  withdrawSignature?: string
  withdrawRecipient?: string
}

interface RemixClaimedFeesBody {
  denomLamports: string
  commitment?: string
  leafIndex?: number
  txSignature?: string
}

export interface PositionRoutesOptions extends PositionControllerDeps {
  /**
   * preHandler chain that authenticates the request and stamps
   * `req.wallet`. Built by `app.ts` from the live Prisma client in
   * production (wallet-signature + beta-access gate); the test harness
   * (`test-kit/route-harness.ts`) supplies a header-stamping stub.
   *
   * Routes shouldn't know which implementation they're using — they
   * just run the chain and trust `req.wallet`.
   */
  authPreHandlers: preHandlerHookHandler[]
  rateLimiterFactory: RateLimiterFactory
}

export async function registerPositionRoutes(app: FastifyInstance, options: PositionRoutesOptions) {
  const controller = createPositionController(options)

  const tags = ['Positions']

  // Independent rate-limit buckets per route family. Wallet-keyed when
  // present (auth runs first in the preHandler chain), IP-keyed when
  // anonymous so the same caller can't sidestep by rotating IPs.
  const intentLimiter = rateLimitHook(options.rateLimiterFactory, {
    windowMs: 60_000,
    max: 10,
    prefix: 'positions:intents',
    keyFor: walletThenIpKey,
  })
  const mutateLimiter = rateLimitHook(options.rateLimiterFactory, {
    windowMs: 60_000,
    max: 5,
    prefix: 'positions:mutate',
    keyFor: walletThenIpKey,
  })

  // The limiter runs as a preHandler *after* the auth chain so it can
  // observe `req.wallet`. Putting it on `onRequest` would defeat the
  // wallet-key path because auth hasn't run yet at that stage.
  const intentPreHandlers = [...options.authPreHandlers, intentLimiter]
  const mutatePreHandlers = [...options.authPreHandlers, mutateLimiter]

  app.post<{ Body: CreateIntentBody }>(
    '/positions/intents',
    {
      schema: { ...createIntentSchema, tags },
      preHandler: intentPreHandlers,
    },
    controller.createIntent,
  )

  // Read-only — wallet auth not required (positions returned by id are
  // already non-secret). Owner-checked routes below need full auth.
  app.get<{ Params: PositionParams }>(
    '/positions/:positionId',
    { schema: { ...positionParamsSchema, tags } },
    controller.getPosition,
  )

  app.post<{ Params: PositionParams; Body: ExecuteIntentBody }>(
    '/positions/:positionId/execute',
    {
      schema: { ...positionParamsSchema, ...executeIntentSchema, tags },
      preHandler: mutatePreHandlers,
    },
    controller.executeIntent,
  )

  app.post<{ Params: PositionParams }>(
    '/positions/:positionId/claim',
    {
      schema: { ...positionParamsSchema, tags },
      preHandler: mutatePreHandlers,
    },
    controller.claimPosition,
  )

  app.post<{ Params: PositionParams }>(
    '/positions/:positionId/withdraw-close',
    {
      schema: { ...positionParamsSchema, tags },
      preHandler: mutatePreHandlers,
    },
    controller.withdrawClosePosition,
  )

  // close/01 — Private Position Close orchestrator entry point. Drives
  // an `active` Position through `dlmm_withdraw_close` -> conditional
  // `dlmm_swap` -> `mixer.deposit`. Non-`active` source state surfaces
  // as 409 via `CloseStateTransitionError`; per-leg failures land in
  // the matching `*_FAILED` terminal with Recovery Guidance baked into
  // the response.
  app.post<{ Params: PositionParams }>(
    '/positions/:positionId/close',
    {
      schema: { ...positionParamsSchema, tags },
      preHandler: mutatePreHandlers,
    },
    controller.closePosition,
  )

  // close/05 — mid-position fee claim (no close). Builds + relayer-
  // signs the fee-claim ix and emits an Activity Record. Position
  // state stays `active`. 409 on non-`active` source state.
  app.post<{ Params: PositionParams }>(
    '/positions/:positionId/claim-fees',
    {
      schema: { ...positionParamsSchema, tags },
      preHandler: mutatePreHandlers,
    },
    controller.claimMidPositionFees,
  )

  // close/05 — re-mix claimed SOL. Wraps the Flow 1 `mixer.deposit`
  // machinery and tags the resulting Activity Record with
  // `source: "fee-claim"`. Caller drives the actual deposit ix via
  // /mixer/deposit; this endpoint records the outcome.
  app.post<{ Params: PositionParams; Body: RemixClaimedFeesBody }>(
    '/positions/:positionId/claim-fees/remix',
    {
      schema: { ...positionParamsSchema, ...remixClaimedFeesSchema, tags },
      preHandler: mutatePreHandlers,
    },
    controller.remixClaimedFees,
  )

  // ── Deposit LP Fallback routes (dust/03 + ADR-0004) ────────────────
  // Every route drives a single sub-state transition. Sequencing rules
  // live in `transitions[]` (execution-state-machine.ts) — illegal
  // transitions map to 409 via `DepositLpStateTransitionError`.
  app.post<{ Params: PositionParams; Body: RecordDepositBody }>(
    '/positions/:positionId/deposit',
    {
      schema: { ...positionParamsSchema, ...recordDepositSchema, tags },
      preHandler: mutatePreHandlers,
    },
    controller.recordDeposit,
  )

  app.post<{ Params: PositionParams }>(
    '/positions/:positionId/lp-pending',
    { schema: { ...positionParamsSchema, tags }, preHandler: mutatePreHandlers },
    controller.markLpPending,
  )

  app.post<{ Params: PositionParams }>(
    '/positions/:positionId/lp-done',
    { schema: { ...positionParamsSchema, tags }, preHandler: mutatePreHandlers },
    controller.markLpDone,
  )

  app.post<{ Params: PositionParams; Body: LpFailedBody }>(
    '/positions/:positionId/lp-failed',
    {
      schema: { ...positionParamsSchema, ...lpFailedSchema, tags },
      preHandler: mutatePreHandlers,
    },
    controller.markLpFailed,
  )

  app.post<{ Params: PositionParams }>(
    '/positions/:positionId/lp-retry',
    { schema: { ...positionParamsSchema, tags }, preHandler: mutatePreHandlers },
    controller.retryLp,
  )

  app.post<{ Params: PositionParams }>(
    '/positions/:positionId/park',
    { schema: { ...positionParamsSchema, tags }, preHandler: mutatePreHandlers },
    controller.parkLp,
  )

  // Plain `markWithdrawn` — kept for internal orchestration / future
  // automated callers. The user-facing surface is `/recover-funds`
  // below, which records the user-signed-recovery audit row before the
  // terminal transition.
  app.post<{ Params: PositionParams }>(
    '/positions/:positionId/withdrawn',
    { schema: { ...positionParamsSchema, tags }, preHandler: mutatePreHandlers },
    controller.markWithdrawn,
  )

  // dust/04 — user-signed Recover Funds reporting endpoint. The
  // browser-side orchestrator built, signed, and broadcast a
  // `mixer.withdraw` directly to RPC (never through the relayer); this
  // endpoint flips the orchestration state to `WITHDRAWN` and stamps
  // the on-chain signature + destination into the audit log. Wired so
  // the "no funds truly stuck" guarantee per ADR-0004 is end-to-end
  // observable from the Position lifecycle.
  app.post<{ Params: PositionParams; Body: RecoverFundsBody }>(
    '/positions/:positionId/recover-funds',
    {
      schema: { ...positionParamsSchema, ...recoverFundsSchema, tags },
      preHandler: mutatePreHandlers,
    },
    controller.recoverFundsUserSigned,
  )
}
