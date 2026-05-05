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
import { createPrismaWaitlistRepository, type WaitlistRepository } from '#modules/waitlist/waitlist.repository'
import { registerWaitlistRoutes } from '#modules/waitlist/waitlist.routes'
import { registerMixerRoutes } from '#modules/mixer/mixer.routes'
import { registerExecutorRoutes } from '#modules/executor/executor.routes'
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
  const app = Fastify({ logger: options.logger ?? false })
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
        { name: 'Waitlist', description: 'Landing page waitlist signups' },
      ],
    },
  })

  await app.register(scalarApiReference, {
    routePrefix: '/docs',
  })

  // Pick the MeteoraExecutor implementation up-front so we can hand the
  // same instance to every position route. Default = mock; switching to
  // the on-chain executor is a single env flag (OCTORA_USE_ONCHAIN_EXECUTOR).
  const meteoraExecutor = createMeteoraExecutorFromConfig(config)

  app.get('/health', async () => ({ ok: true }))
  app.register(registerPositionRoutes, { ...repos, meteoraExecutor })
  app.register(registerDlmmRoutes)
  app.register(registerWaitlistRoutes, { waitlistRepo: repos.waitlistRepo })
  app.register(registerMixerRoutes)
  app.register(registerExecutorRoutes)

  return app
}
