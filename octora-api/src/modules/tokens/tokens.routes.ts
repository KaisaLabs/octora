import type { FastifyInstance } from 'fastify'

import { getTokenIconsHandler } from './tokens.controller'
import { getTokenIconsSchema } from './tokens.schema'

export async function registerTokensRoutes(app: FastifyInstance) {
  const tags = ['Tokens']
  app.get('/tokens/icons', { schema: { ...getTokenIconsSchema, tags } }, getTokenIconsHandler)
}
