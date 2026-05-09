import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifySwagger from '@fastify/swagger'
import scalarApiReference from '@scalar/fastify-api-reference'

import { createPrismaClient } from '#common/db/client'
import { loadConfig } from '#common/config'
import { runHealthCheck } from '#common/health'
import { createPrismaPositionRepository, type PositionRepository } from '#modules/positions/position.repository'
import { createPrismaActivityRepository, type ActivityRepository } from '#modules/positions/activity.repository'
import { createPrismaReconciliationRepository, type ReconciliationRepository } from '#modules/indexer/indexer.repository'
import { registerPositionRoutes } from '#modules/positions/position.routes'
import { registerDlmmRoutes } from '#modules/dlmm/dlmm.routes'
import { registerPricesRoutes } from '#modules/prices/prices.routes'
import { createPrismaWaitlistRepository, type WaitlistRepository } from '#modules/waitlist/waitlist.repository'
import { registerWaitlistRoutes } from '#modules/waitlist/waitlist.routes'
import { registerMixerRoutes } from '#modules/mixer/mixer.routes'
import { registerExecutorRoutes } from '#modules/executor/executor.routes'
import { registerDepositsRoutes } from '#modules/deposits'
import { registerRelayerRoutes } from '#modules/relayer'
import { registerAuthRoutes } from '#modules/auth/auth.routes'
import { registerAdminRoutes } from '#modules/admin/admin.routes'
import { createMeteoraExecutorFromConfig } from '#modules/execution/clients'

export interface AppRepositories {
  positionRepo: PositionRepository
  activityRepo: ActivityRepository
  reconciliationRepo: ReconciliationRepository
  waitlistRepo: WaitlistRepository
}

export interface CreateAppOptions {
  repos?: AppRepositories
  logger?: boolean
}

function createPrismaRepositories(): { repos: AppRepositories; client: ReturnType<typeof createPrismaClient> } {
  const client = createPrismaClient()
  return {
    client,
    repos: {
      positionRepo: createPrismaPositionRepository(client),
      activityRepo: createPrismaActivityRepository(client),
      reconciliationRepo: createPrismaReconciliationRepository(client),
      waitlistRepo: createPrismaWaitlistRepository(client),
    },
  }
}

export async function createApp(options: CreateAppOptions = {}) {
  const config = loadConfig()
  // pluginTimeout bumped from the 10s default because registerMixerRoutes
  // awaits hydrateFromChain() during registration — paginated
  // getSignaturesForAddress + getTransaction calls regularly exceed 10s on
  // public RPC endpoints. See mixer.routes.ts for why this must stay awaited.
  const app = Fastify({ logger: options.logger ?? false, pluginTimeout: 120_000 })
  // /health needs a Prisma client to ping; we keep the same instance the
  // repos use so a connection-pool exhaustion shows up in the health probe.
  let prismaClient: ReturnType<typeof createPrismaClient> | undefined
  let repos: AppRepositories
  if (options.repos) {
    repos = options.repos
  } else {
    const built = createPrismaRepositories()
    repos = built.repos
    prismaClient = built.client
  }

  await app.register(cors, {
    origin: config.frontendUrl,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Octora API',
        description: 'Octora — Solana liquidity management API',
        version: '0.1.0',
      },
      tags: [
        { name: 'Auth', description: 'Wallet-signature challenge / nonce issuance' },
        { name: 'Positions', description: 'Position intents and lifecycle' },
        { name: 'DLMM', description: 'Meteora DLMM pool data and analytics' },
        { name: 'Prices', description: 'Realtime token USD prices via Jupiter' },
        { name: 'Waitlist', description: 'Landing page waitlist signups' },
        { name: 'Deposits', description: 'Private deposit orchestration' },
        { name: 'Relayer', description: 'Mixer relayer (Groth16-proven withdrawals)' },
        { name: 'Admin', description: 'Operator-only admin endpoints (token-gated)' },
      ],
    },
  })

  await app.register(scalarApiReference, {
    routePrefix: '/docs',
  })

  // Always print stack traces for unhandled 500s, regardless of the request
  // logger setting. Without this Fastify swallows exceptions to a generic
  // {"statusCode":500,"message":"..."} body which makes debugging by guesswork.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const statusCode = err.statusCode ?? 500
    if (statusCode >= 500) {
      // eslint-disable-next-line no-console
      console.error(
        `[api] ${req.method} ${req.url} → ${statusCode} ${err.message}\n${err.stack ?? '<no stack>'}`,
      )
    }
    reply.status(statusCode).send({
      statusCode,
      error: err.name ?? 'Error',
      message: err.message,
    })
  })

  // Pick the MeteoraExecutor implementation up-front so we can hand the
  // same instance to every position route. Default = mock; switching to
  // the on-chain executor is a single env flag (OCTORA_USE_ONCHAIN_EXECUTOR).
  const meteoraExecutor = createMeteoraExecutorFromConfig(config)

  // Real liveness/readiness probe. Returns 503 on any failed dependency so
  // load balancers and uptime monitors actually catch DB / RPC / relayer /
  // mixer-paused outages instead of routing traffic into a broken backend.
  // Falls back to a minimal alive-only probe when the app is hosting
  // injected repos without a Prisma client (test harness path).
  app.get('/health', async (_req, reply) => {
    if (!prismaClient) {
      return reply.send({ status: 'ok', mode: 'minimal' })
    }
    const report = await runHealthCheck(prismaClient, config)
    const code = report.status === 'ok' ? 200 : 503
    return reply.code(code).send(report)
  })
  // Wallet-signature auth + admin routes (P0-20, P1-25). Both depend on the
  // live Prisma client; they degrade to no-op when the app is built with
  // injected repos and no client (test harness).
  if (prismaClient) {
    await app.register(registerAuthRoutes, { prisma: prismaClient })
    await app.register(registerAdminRoutes, {
      waitlistRepo: repos.waitlistRepo,
      adminApiToken: config.adminApiToken,
    })
  }

  app.register(registerPositionRoutes, {
    ...repos,
    meteoraExecutor,
    betaCaps: config.betaCaps,
    prisma: prismaClient,
  })
  app.register(registerDlmmRoutes)
  app.register(registerPricesRoutes)
  app.register(registerWaitlistRoutes, { waitlistRepo: repos.waitlistRepo })
  app.register(registerMixerRoutes, { mixerProgramId: config.mixerProgramId })
  app.register(registerExecutorRoutes, {
    executorProgramId: config.executorProgramId,
    relayerKeypairPath: config.executorRelayerKeypairPath,
  })
  app.register(registerDepositsRoutes, { mixerDenomination: config.mixerDenomination })

  // Mixer relayer is opt-in: only mount when explicitly enabled, since it
  // holds a hot wallet. Driven by OCTORA_MIXER_RELAYER_ENABLED=true plus the
  // other OCTORA_MIXER_RELAYER_* env vars (see common/config.ts).
  if (config.mixerRelayer) {
    await registerRelayerRoutes(app, config.mixerRelayer, prismaClient ?? null)
  }

  return app
}
