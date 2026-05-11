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
  getPoolBins,
  MeteoraApiError,
} from './dlmm.service'
import {
  listSwapSourceCandidates,
  NoSwapSourceAvailableError,
} from '#modules/executor/swap-pool-resolver'

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

interface BinsQuery extends NetworkQuery {
  count?: number
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
  const { network = 'devnet', search, page, pageSize, sortBy, filterBy } = request.query
  const result = await listPools(network, { search, page, pageSize, sortBy, filterBy })
  return reply.send(result)
}

export async function getPoolHandler(
  request: FastifyRequest<{ Params: AddressParams; Querystring: NetworkQuery }>,
  reply: FastifyReply
) {
  const pool = await getPool(request.params.address, request.query.network ?? 'devnet')
  if (!pool) return reply.code(404).send({ message: 'Pool not found' })
  return reply.send(pool)
}

export async function listGroupsHandler(
  request: FastifyRequest<{ Querystring: PaginationQuery }>,
  reply: FastifyReply
) {
  const { network = 'devnet', page, pageSize } = request.query
  const result = await listGroups(network, { page, pageSize })
  return reply.send(result)
}

export async function getGroupHandler(
  request: FastifyRequest<{ Params: MintPairParams; Querystring: PaginationQuery }>,
  reply: FastifyReply
) {
  try {
    const { network = 'devnet', page, pageSize } = request.query
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
  const { network = 'devnet', startTime, endTime, resolution } = request.query
  const candles = await getOhlcv(request.params.address, network, { startTime, endTime, resolution })
  return reply.send({ data: candles })
}

export async function getVolumeHistoryHandler(
  request: FastifyRequest<{ Params: AddressParams; Querystring: TimeRangeQuery }>,
  reply: FastifyReply
) {
  const { network = 'devnet', startTime, endTime, resolution } = request.query
  const buckets = await getVolumeHistory(request.params.address, network, { startTime, endTime, resolution })
  return reply.send({ data: buckets })
}

export async function getPoolBinsHandler(
  request: FastifyRequest<{ Params: AddressParams; Querystring: BinsQuery }>,
  reply: FastifyReply
) {
  try {
    const { network = 'devnet', count } = request.query
    const result = await getPoolBins(request.params.address, network, { count })
    return reply.send(result)
  } catch (err) {
    return handleError(err, reply)
  }
}

export async function getProtocolMetricsHandler(
  request: FastifyRequest<{ Querystring: NetworkQuery }>,
  reply: FastifyReply
) {
  const metrics = await getProtocolMetrics(request.query.network ?? 'devnet')
  return reply.send(metrics)
}

interface SwapSourceQuery extends NetworkQuery {
  /** Direction flag — when true, the user is selling tokenY for tokenX. */
  swapForY?: boolean
}

/**
 * GET /dlmm/pools/:address/swap-source — recommend a SOL-paired source
 * pool for swapping into the target pool's non-SOL token (Plan 2/3).
 *
 * Returns:
 *   - 200 + `{ recommended, candidates }` when a viable source exists.
 *   - 404 when the target pool is SOL-paired (no swap path needed).
 *   - 422 when the target pool needs a swap but no SOL-paired source
 *     pool exists for the target's non-SOL token.
 */
export async function getSwapSourceHandler(
  request: FastifyRequest<{
    Params: AddressParams
    Querystring: SwapSourceQuery
  }>,
  reply: FastifyReply,
) {
  const network = request.query.network ?? 'devnet'
  const swapForY = request.query.swapForY ?? false

  const target = await getPool(request.params.address, network)
  if (!target) return reply.code(404).send({ message: 'Pool not found' })

  const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112'
  const targetIsSolQuoted =
    target.tokenX.mint === NATIVE_SOL_MINT || target.tokenY.mint === NATIVE_SOL_MINT
  if (targetIsSolQuoted) {
    return reply.code(404).send({
      code: 'no_swap_needed',
      message: 'Target pool already pairs with SOL — no swap source required.',
    })
  }

  const nonSolMint = swapForY ? target.tokenY.mint : target.tokenX.mint

  try {
    const candidates = await listSwapSourceCandidates({
      network,
      targetPoolAddress: target.address,
      nonSolMint,
    })
    const usable = candidates.filter((c) => !c.isTarget)
    if (usable.length === 0) {
      return reply.code(422).send({
        code: 'no_swap_source_available',
        message:
          `No SOL-paired Meteora DLMM pool found for ${nonSolMint} other than the LP target. ` +
          `Privacy-preserving swap path unavailable.`,
        targetPoolAddress: target.address,
        nonSolMint,
      })
    }

    return reply.send({
      recommended: usable[0]!.pool,
      candidates: usable.map((c) => c.pool),
      target: { address: target.address, tokenX: target.tokenX, tokenY: target.tokenY },
    })
  } catch (err) {
    if (err instanceof NoSwapSourceAvailableError) {
      return reply.code(422).send({
        code: 'no_swap_source_available',
        message: err.message,
      })
    }
    return handleError(err, reply)
  }
}
