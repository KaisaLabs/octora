import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

import { makeRateLimiter } from '#modules/mixer/rate-limit'

import { createPositionController, type PositionControllerDeps } from './position.controller'
import { createIntentSchema, executeIntentSchema, positionParamsSchema } from './position.schema'

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
}

export async function registerPositionRoutes(app: FastifyInstance, options: PositionRoutesOptions) {
  const controller = createPositionController(options)

  const tags = ['Positions']

  // Independent rate-limit buckets per route family:
  // - intents creation: 10/min/IP
  // - mutating ops on a specific position: 5/min/IP
  // Wallet-keyed quotas come with the Phase 3 Redis-backed limiter.
  const intentLimiter = makeRateLimiter({ windowMs: 60_000, max: 10 })
  const mutateLimiter = makeRateLimiter({ windowMs: 60_000, max: 5 })

  const preHandlers = options.authPreHandlers

  app.post<{ Body: CreateIntentBody }>(
    '/positions/intents',
    {
      schema: { ...createIntentSchema, tags },
      onRequest: intentLimiter,
      preHandler: preHandlers,
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
      onRequest: mutateLimiter,
      preHandler: preHandlers,
    },
    controller.executeIntent,
  )

  app.post<{ Params: PositionParams }>(
    '/positions/:positionId/claim',
    {
      schema: { ...positionParamsSchema, tags },
      onRequest: mutateLimiter,
      preHandler: preHandlers,
    },
    controller.claimPosition,
  )

  app.post<{ Params: PositionParams }>(
    '/positions/:positionId/withdraw-close',
    {
      schema: { ...positionParamsSchema, tags },
      onRequest: mutateLimiter,
      preHandler: preHandlers,
    },
    controller.withdrawClosePosition,
  )
}
