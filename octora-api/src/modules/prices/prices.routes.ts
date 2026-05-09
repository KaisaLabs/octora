import type { FastifyInstance } from 'fastify'

import { getPricesHandler } from './prices.controller'
import { getPricesSchema } from './prices.schema'

export async function registerPricesRoutes(app: FastifyInstance) {
  const tags = ['Prices']
  app.get('/prices', { schema: { ...getPricesSchema, tags } }, getPricesHandler)
}
