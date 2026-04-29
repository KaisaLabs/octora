import type { FastifyReply, FastifyRequest } from 'fastify'

import type { Network } from './dlmm.service'
import {
  listPools,
  getPool,
  listGroups,
  getGroup,
  getOhlcv,
  getVolumeHistory,
  getProtocolMetrics,
  MeteoraApiError,
} from './dlmm.service'

interface NetworkQuery {
  network?: Network
}

interface PaginationQuery extends NetworkQuery {
  page?: number
  pageSize?: number
}

interface ListPoolsQuery extends PaginationQuery {
  search?: string
  sortBy?: string
  filterBy?: string
}

interface AddressParams {
  address: string
}

interface MintPairParams {
  mintPair: string
}

interface TimeRangeQuery extends NetworkQuery {
  startTime?: number
  endTime?: number
  resolution?: string
}

function handleError(err: unknown, reply: FastifyReply) {
  if (err instanceof MeteoraApiError) {
    return reply.code(err.status).send({ message: err.message })
  }
  throw err
}

export async function listPoolsHandler(
  request: FastifyRequest<{ Querystring: ListPoolsQuery }>,
  reply: FastifyReply
) {
  const { network = 'mainnet', search, page, pageSize, sortBy, filterBy } = request.query
  const result = await listPools(network, { search, page, pageSize, sortBy, filterBy })
  return reply.send(result)
}

export async function getPoolHandler(
  request: FastifyRequest<{ Params: AddressParams; Querystring: NetworkQuery }>,
  reply: FastifyReply
) {
  const pool = await getPool(request.params.address, request.query.network ?? 'mainnet')
  if (!pool) return reply.code(404).send({ message: 'Pool not found' })
  return reply.send(pool)
}

export async function listGroupsHandler(
  request: FastifyRequest<{ Querystring: PaginationQuery }>,
  reply: FastifyReply
) {
  const { network = 'mainnet', page, pageSize } = request.query
  const result = await listGroups(network, { page, pageSize })
  return reply.send(result)
}

export async function getGroupHandler(
  request: FastifyRequest<{ Params: MintPairParams; Querystring: PaginationQuery }>,
  reply: FastifyReply
) {
  try {
    const { network = 'mainnet', page, pageSize } = request.query
    const result = await getGroup(request.params.mintPair, network, { page, pageSize })
    return reply.send(result)
  } catch (err) {
    return handleError(err, reply)
  }
}

export async function getOhlcvHandler(
  request: FastifyRequest<{ Params: AddressParams; Querystring: TimeRangeQuery }>,
  reply: FastifyReply
) {
  const { network = 'mainnet', startTime, endTime, resolution } = request.query
  const candles = await getOhlcv(request.params.address, network, { startTime, endTime, resolution })
  return reply.send({ data: candles })
}

export async function getVolumeHistoryHandler(
  request: FastifyRequest<{ Params: AddressParams; Querystring: TimeRangeQuery }>,
  reply: FastifyReply
) {
  const { network = 'mainnet', startTime, endTime, resolution } = request.query
  const buckets = await getVolumeHistory(request.params.address, network, { startTime, endTime, resolution })
  return reply.send({ data: buckets })
}

export async function getProtocolMetricsHandler(
  request: FastifyRequest<{ Querystring: NetworkQuery }>,
  reply: FastifyReply
) {
  const metrics = await getProtocolMetrics(request.query.network ?? 'mainnet')
  return reply.send(metrics)
}
