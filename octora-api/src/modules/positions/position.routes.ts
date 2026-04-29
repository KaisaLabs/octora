import type { FastifyInstance } from 'fastify'

import { createPositionController } from './position.controller'
import { createIntentSchema, executeIntentSchema, positionParamsSchema } from './position.schema'
import type { PositionServiceDependencies } from './position.service'

export async function registerPositionRoutes(app: FastifyInstance, options: PositionServiceDependencies) {
  const controller = createPositionController(options)

  app.post('/positions/intents', { schema: createIntentSchema }, controller.createIntent)
  app.get('/positions/:positionId', { schema: positionParamsSchema }, controller.getPosition)
  app.post('/positions/:positionId/execute', { schema: { ...positionParamsSchema, ...executeIntentSchema } }, controller.executeIntent)
  app.post('/positions/:positionId/claim', { schema: positionParamsSchema }, controller.claimPosition)
  app.post('/positions/:positionId/withdraw-close', { schema: positionParamsSchema }, controller.withdrawClosePosition)
}
