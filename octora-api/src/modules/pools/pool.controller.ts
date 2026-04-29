import type { FastifyReply, FastifyRequest } from 'fastify'

import { listPools, getPoolDetail } from './pool.service'

interface ListPoolsQuery {
  network?: 'mainnet' | 'devnet'
  search?: string
  limit?: number
  offset?: number
}

interface GetPoolParams {
  address: string
}

interface GetPoolQuery {
  network?: 'mainnet' | 'devnet'
}

export async function listPoolsHandler(
  request: FastifyRequest<{ Querystring: ListPoolsQuery }>,
  reply: FastifyReply
) {
  const network = request.query.network ?? 'mainnet'
  const pools = await listPools(network, {
    search: request.query.search,
    limit: request.query.limit,
    offset: request.query.offset,
  })
  return reply.send({ pools })
}

export async function getPoolHandler(
  request: FastifyRequest<{ Params: GetPoolParams; Querystring: GetPoolQuery }>,
  reply: FastifyReply
) {
  const network = request.query.network ?? 'mainnet'
  const pool = await getPoolDetail(request.params.address, network)

  if (!pool) {
    return reply.code(404).send({ message: 'Pool not found' })
  }

  return reply.send(pool)
}
