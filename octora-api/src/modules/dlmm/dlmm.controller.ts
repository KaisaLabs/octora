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
  getSwapQuote,
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

interface SwapQuoteQuery extends NetworkQuery {
  /** Lamports the user is paying in. Decimal string so non-SOL-priced
   *  amounts like 1e15 meme-lamports survive JSON without precision loss. */
  amountIn: string
  /** Direction flag — tokenX → tokenY when true. */
  swapForY: boolean
  /** Slippage tolerance for the returned `minOut`, 0–2000 BPS. */
  allowedSlippageBps?: number
}

/**
 * GET /dlmm/pools/:address/swap-quote — compute expected output and
 * slippage-protected `minOut` for a swap against the named DLMM pool.
 *
 * The browser orchestrators (privateExit, privateClaim) call this before
 * submitting `dlmm_swap` so the on-chain `min_amount_out` arg reflects the
 * actual pool depth and price impact for the user's swap size. Without
 * this, the orchestrators previously used a 1:1 placeholder that caused
 * every real swap for tokens with non-unit per-lamport value to revert.
 */
export async function getSwapQuoteHandler(
  request: FastifyRequest<{
    Params: AddressParams
    Querystring: SwapQuoteQuery
  }>,
  reply: FastifyReply,
) {
  const network = request.query.network ?? 'devnet'
  if (!request.query.amountIn) {
    return reply.code(400).send({ message: 'amountIn is required (lamports as decimal string).' })
  }
  let amountIn: bigint
  try {
    amountIn = BigInt(request.query.amountIn)
    if (amountIn <= 0n) throw new Error('amountIn must be > 0')
  } catch (err) {
    return reply
      .code(400)
      .send({ message: `amountIn must be a positive lamports integer: ${err instanceof Error ? err.message : 'invalid'}` })
  }
  // Fastify's query parser delivers booleans as strings — coerce so
  // `swapForY=false` doesn't silently behave as truthy.
  const swapForYRaw = request.query.swapForY as unknown
  const swapForY =
    swapForYRaw === true || swapForYRaw === 'true' || swapForYRaw === 1 || swapForYRaw === '1'
  const allowedSlippageBps =
    request.query.allowedSlippageBps !== undefined
      ? Number(request.query.allowedSlippageBps)
      : undefined
  try {
    const result = await getSwapQuote(request.params.address, network, {
      amountIn,
      swapForY,
      allowedSlippageBps,
    })
    return reply.send(result)
  } catch (err) {
    return handleError(err, reply)
  }
}
