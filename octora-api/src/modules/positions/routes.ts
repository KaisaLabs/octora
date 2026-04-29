import type { FastifyInstance } from 'fastify'

import { createPositionController } from './controller'
import { createIntentSchema, executeIntentSchema, positionParamsSchema } from './schema'
import type { OrchestratorDb } from '../db'

interface RegisterRoutesOptions {
  db: OrchestratorDb
}

export async function registerPositionRoutes(app: FastifyInstance, options: RegisterRoutesOptions) {
  const controller = createPositionController(options.db)

  app.post('/positions/intents', { schema: createIntentSchema }, controller.createIntent)
  app.get('/positions/:positionId', { schema: positionParamsSchema }, controller.getPosition)
  app.post('/positions/:positionId/execute', { schema: { ...positionParamsSchema, ...executeIntentSchema } }, controller.executeIntent)
  app.post('/positions/:positionId/claim', { schema: positionParamsSchema }, controller.claimPosition)
  app.post('/positions/:positionId/withdraw-close', { schema: positionParamsSchema }, controller.withdrawClosePosition)
}
