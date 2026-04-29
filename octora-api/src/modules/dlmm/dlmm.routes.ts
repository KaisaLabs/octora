import type { FastifyInstance } from 'fastify'

import {
  listPoolsHandler,
  getPoolHandler,
  listGroupsHandler,
  getGroupHandler,
  getOhlcvHandler,
  getVolumeHistoryHandler,
  getProtocolMetricsHandler,
} from './dlmm.controller'
import {
  listPoolsSchema,
  getPoolSchema,
  listGroupsSchema,
  getGroupSchema,
  getOhlcvSchema,
  getVolumeHistorySchema,
  getProtocolMetricsSchema,
} from './dlmm.schema'

export async function registerDlmmRoutes(app: FastifyInstance) {
  app.get('/dlmm/pools', { schema: listPoolsSchema }, listPoolsHandler)
  app.get('/dlmm/pools/groups', { schema: listGroupsSchema }, listGroupsHandler)
  app.get('/dlmm/pools/groups/:mintPair', { schema: getGroupSchema }, getGroupHandler)
  app.get('/dlmm/pools/:address', { schema: getPoolSchema }, getPoolHandler)
  app.get('/dlmm/pools/:address/ohlcv', { schema: getOhlcvSchema }, getOhlcvHandler)
  app.get('/dlmm/pools/:address/volume/history', { schema: getVolumeHistorySchema }, getVolumeHistoryHandler)
  app.get('/dlmm/stats', { schema: getProtocolMetricsSchema }, getProtocolMetricsHandler)
}
