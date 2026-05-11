import type { FastifyInstance } from 'fastify'

import {
  listPoolsHandler,
  getPoolHandler,
  listGroupsHandler,
  getGroupHandler,
  getOhlcvHandler,
  getVolumeHistoryHandler,
  getPoolBinsHandler,
  getProtocolMetricsHandler,
  getSwapSourceHandler,
} from './dlmm.controller'
import {
  listPoolsSchema,
  getPoolSchema,
  listGroupsSchema,
  getGroupSchema,
  getOhlcvSchema,
  getVolumeHistorySchema,
  getPoolBinsSchema,
  getProtocolMetricsSchema,
  getSwapSourceSchema,
} from './dlmm.schema'

export async function registerDlmmRoutes(app: FastifyInstance) {
  const tags = ['DLMM']

  app.get('/dlmm/pools', { schema: { ...listPoolsSchema, tags } }, listPoolsHandler)
  app.get('/dlmm/pools/groups', { schema: { ...listGroupsSchema, tags } }, listGroupsHandler)
  app.get('/dlmm/pools/groups/:mintPair', { schema: { ...getGroupSchema, tags } }, getGroupHandler)
  app.get('/dlmm/pools/:address', { schema: { ...getPoolSchema, tags } }, getPoolHandler)
  app.get('/dlmm/pools/:address/bins', { schema: { ...getPoolBinsSchema, tags } }, getPoolBinsHandler)
  app.get('/dlmm/pools/:address/ohlcv', { schema: { ...getOhlcvSchema, tags } }, getOhlcvHandler)
  app.get('/dlmm/pools/:address/volume/history', { schema: { ...getVolumeHistorySchema, tags } }, getVolumeHistoryHandler)
  app.get('/dlmm/stats', { schema: { ...getProtocolMetricsSchema, tags } }, getProtocolMetricsHandler)
  app.get(
    '/dlmm/pools/:address/swap-source',
    { schema: { ...getSwapSourceSchema, tags } },
    getSwapSourceHandler,
  )
}
