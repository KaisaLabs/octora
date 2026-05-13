import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

import { rateLimitHook, walletThenIpKey, type RateLimiterFactory } from '#common/ratelimit'

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
}
