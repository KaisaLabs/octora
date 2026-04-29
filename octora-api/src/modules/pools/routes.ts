import type { FastifyInstance } from 'fastify'

import { listPoolsHandler, getPoolHandler } from './controller'
import { listPoolsSchema, getPoolSchema } from './schema'

export async function registerPoolRoutes(app: FastifyInstance) {
  app.get('/pools', { schema: listPoolsSchema }, listPoolsHandler)
  app.get('/pools/:address', { schema: getPoolSchema }, getPoolHandler)
}
