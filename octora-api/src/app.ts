import Fastify from 'fastify'
import cors from '@fastify/cors'

import { createPrismaClient } from '#common/db/client'
import { loadConfig } from '#common/config'
import { createPrismaPositionRepository, type PositionRepository } from '#modules/positions/position.repository'
import { createPrismaActivityRepository, type ActivityRepository } from '#modules/positions/activity.repository'
import { createPrismaReconciliationRepository, type ReconciliationRepository } from '#modules/indexer/indexer.repository'
import { registerPositionRoutes } from '#modules/positions/position.routes'
import { registerPoolRoutes } from '#modules/pools/pool.routes'

export interface AppRepositories {
  positionRepo: PositionRepository
  activityRepo: ActivityRepository
  reconciliationRepo: ReconciliationRepository
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

  app.get('/health', async () => ({ ok: true }))
  app.register(registerPositionRoutes, repos)
  app.register(registerPoolRoutes)

  return app
}
