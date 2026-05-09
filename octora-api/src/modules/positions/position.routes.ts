import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'

import { requireBetaAccess, requireWalletSignature } from '#common/auth'
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

/**
 * Test-only default wallet. 32 chars of '1' — base58-decodes to the
 * all-zero pubkey (Solana's `SystemProgram.programId`). Always valid as
 * a `PublicKey` constructor input, so the stamper below never has to
 * recover from a bad default.
 */
const TEST_DEFAULT_WALLET = '11111111111111111111111111111111'

/**
 * Test-only preHandler. Skipped in production (where the real auth
 * preHandlers run instead). Stamps `req.wallet` from the
 * `x-wallet-address` header when present, falling back to
 * {@link TEST_DEFAULT_WALLET}. Gated by `options.prisma === undefined`,
 * which only happens in the in-process test harness.
 */
async function testWalletStamper(req: import('fastify').FastifyRequest): Promise<void> {
  const header = req.headers['x-wallet-address']
  const address = typeof header === 'string' && header.trim().length > 0
    ? header.trim()
    : TEST_DEFAULT_WALLET
  const { PublicKey } = await import('@solana/web3.js')
  let pubkey: import('@solana/web3.js').PublicKey
  try {
    pubkey = new PublicKey(address)
  } catch {
    pubkey = new PublicKey(TEST_DEFAULT_WALLET)
  }
  req.wallet = { address: pubkey.toBase58(), pubkey }
}

export interface PositionRoutesOptions extends PositionControllerDeps {
  /**
   * Prisma client used by the auth preHandlers. When omitted (test
   * harness), routes run without auth — only safe in tests because
   * production wiring in `app.ts` always passes the live client.
   */
  prisma?: PrismaClient
}

export async function registerPositionRoutes(app: FastifyInstance, options: PositionRoutesOptions) {
  const controller = createPositionController(options)

  const tags = ['Positions']

  // Independent rate-limit buckets per route family. Per audit P1-24:
  // - intents creation: 10/min/IP
  // - mutating ops on a specific position: 5/min/IP
  // (Wallet-keyed quotas need a Redis-backed limiter — call out as P3.)
  const intentLimiter = makeRateLimiter({ windowMs: 60_000, max: 10 })
  const mutateLimiter = makeRateLimiter({ windowMs: 60_000, max: 5 })

  // Auth + beta gate. Production wiring always supplies a Prisma client.
  // The test harness path (no `prisma`) instead mounts a dev-only
  // preHandler that stamps `req.wallet` from the `x-wallet-address`
  // header (or a default), so the controller's owner / wallet checks
  // still exercise the same code paths without a real wallet+signature
  // pipeline.
  const preHandlers = options.prisma
    ? [requireWalletSignature(options.prisma), requireBetaAccess(options.prisma)]
    : [testWalletStamper]

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
