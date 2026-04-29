import type { FastifyInstance } from 'fastify'

import { createPositionController } from './position.controller'
import { createIntentSchema, executeIntentSchema, positionParamsSchema } from './position.schema'
import type { PositionServiceDependencies } from './position.service'

export async function registerPositionRoutes(app: FastifyInstance, options: PositionServiceDependencies) {
  const controller = createPositionController(options)

  const tags = ['Positions']

  app.post('/positions/intents', { schema: { ...createIntentSchema, tags } }, controller.createIntent)
  app.get('/positions/:positionId', { schema: { ...positionParamsSchema, tags } }, controller.getPosition)
  app.post('/positions/:positionId/execute', { schema: { ...positionParamsSchema, ...executeIntentSchema, tags } }, controller.executeIntent)
  app.post('/positions/:positionId/claim', { schema: { ...positionParamsSchema, tags } }, controller.claimPosition)
  app.post('/positions/:positionId/withdraw-close', { schema: { ...positionParamsSchema, tags } }, controller.withdrawClosePosition)
}
