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
  getSwapQuoteHandler,
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
  // No schema validation here yet — the route is shipped without a
  // matching block in dlmm.schema.ts since the Meteora SDK quote payload
  // is large and not yet stabilized for OpenAPI surface.
  app.get('/dlmm/pools/:address/swap-quote', { schema: { tags } }, getSwapQuoteHandler)
}
