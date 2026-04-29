import Fastify from 'fastify'
import cors from '@fastify/cors'

import { createPrismaDb, type OrchestratorDb } from './modules/db'
import { registerPositionRoutes } from './modules/positions/routes'
import { registerPoolRoutes } from './modules/pools/routes'

export interface CreateAppOptions {
  db?: OrchestratorDb
  logger?: boolean
}

export async function createApp(options: CreateAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false })
  const db = options.db ?? createPrismaDb()

  await app.register(cors, {
    origin: process.env.FRONTEND_URL ?? '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })

  app.get('/health', async () => ({ ok: true }))
  app.register(registerPositionRoutes, { db })
  app.register(registerPoolRoutes)

  return app
}
