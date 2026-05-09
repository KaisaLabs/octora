import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifySwagger from '@fastify/swagger'
import scalarApiReference from '@scalar/fastify-api-reference'

import { createPrismaClient } from '#common/db/client'
import { loadConfig } from '#common/config'
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

function createPrismaRepositories(): AppRepositories {
  const client = createPrismaClient()
  return {
    positionRepo: createPrismaPositionRepository(client),
    activityRepo: createPrismaActivityRepository(client),
    reconciliationRepo: createPrismaReconciliationRepository(client),
    waitlistRepo: createPrismaWaitlistRepository(client),
  }
}

export async function createApp(options: CreateAppOptions = {}) {
  const config = loadConfig()
  // pluginTimeout bumped from the 10s default because registerMixerRoutes
  // awaits hydrateFromChain() during registration — paginated
  // getSignaturesForAddress + getTransaction calls regularly exceed 10s on
  // public RPC endpoints. See mixer.routes.ts for why this must stay awaited.
  const app = Fastify({ logger: options.logger ?? false, pluginTimeout: 120_000 })
  const repos = options.repos ?? createPrismaRepositories()

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
        { name: 'Positions', description: 'Position intents and lifecycle' },
        { name: 'DLMM', description: 'Meteora DLMM pool data and analytics' },
        { name: 'Prices', description: 'Realtime token USD prices via Jupiter' },
        { name: 'Waitlist', description: 'Landing page waitlist signups' },
        { name: 'Deposits', description: 'Private deposit orchestration' },
        { name: 'Relayer', description: 'Mixer relayer (Groth16-proven withdrawals)' },
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

  app.get('/health', async () => ({ ok: true }))
  app.register(registerPositionRoutes, { ...repos, meteoraExecutor })
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
    await registerRelayerRoutes(app, config.mixerRelayer)
  }

  return app
}
