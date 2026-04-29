import type {
  PoolSummary,
  PoolDetail,
  PoolGroup,
  OhlcvCandle,
  VolumeHistoryBucket,
  ProtocolMetrics,
  PaginatedResponse,
} from './dlmm.types'

const API_BASE = {
  mainnet: 'https://dlmm.datapi.meteora.ag',
  devnet: 'https://dlmm-api.devnet.meteora.ag',
} as const

export type Network = 'mainnet' | 'devnet'

// Rate limit: 30 RPS across all DLMM endpoints
async function fetchMeteora(network: Network, path: string, params?: URLSearchParams): Promise<Response> {
  const base = API_BASE[network]
  const qs = params?.toString()
  const url = qs ? `${base}${path}?${qs}` : `${base}${path}`

  const res = await fetch(url)
  if (!res.ok) {
    throw new MeteoraApiError(res.status, `Meteora API error: ${res.status}`)
  }
  return res
}

export class MeteoraApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'MeteoraApiError'
  }
}

// --- Meteora raw response types ---

interface MeteoraToken {
  address: string
  symbol: string
  decimals: number
}

interface MeteoraPool {
  address: string
  name: string
  token_x: MeteoraToken
  token_y: MeteoraToken
  pool_config: {
    bin_step: number
    base_fee_pct: number
    max_fee_pct: number
    protocol_fee_pct: number
  }
  tvl: number
  current_price: number
  apr: number
  apy: number
  dynamic_fee_pct: number
  created_at: number
  volume: Record<string, number>
  fees: Record<string, number>
}

interface MeteoraPagedResponse {
  total: number
  pages: number
  current_page: number
  page_size: number
  data: MeteoraPool[]
}

// --- Mappers ---

function mapPool(pool: MeteoraPool, network: Network): PoolSummary {
  return {
    address: pool.address,
    name: pool.name,
    pair: `${pool.token_x.symbol} / ${pool.token_y.symbol}`,
    tokenX: { symbol: pool.token_x.symbol, mint: pool.token_x.address, decimals: pool.token_x.decimals },
    tokenY: { symbol: pool.token_y.symbol, mint: pool.token_y.address, decimals: pool.token_y.decimals },
    tvl: pool.tvl,
    volume24h: pool.volume['24h'] ?? 0,
    fees24h: pool.fees['24h'] ?? 0,
    apr: pool.apr,
    feeBps: pool.pool_config.base_fee_pct * 100,
    binStep: pool.pool_config.bin_step,
    baseFee: pool.pool_config.base_fee_pct,
    network,
  }
}

function mapPoolDetail(pool: MeteoraPool, network: Network): PoolDetail {
  return {
    ...mapPool(pool, network),
    activeBinId: 0,
    price: pool.current_price,
    priceRange: { min: 0, max: 0 },
    liquidityShape: 'spot',
    totalLiquidity: pool.tvl,
    feeInfo: {
      baseFeeBps: pool.pool_config.base_fee_pct * 100,
      maxFeeBps: pool.pool_config.max_fee_pct * 100,
      protocolFeeBps: pool.pool_config.protocol_fee_pct * 100,
    },
  }
}

// --- Public API ---

export async function listPools(
  network: Network,
  opts: { search?: string; page?: number; pageSize?: number; sortBy?: string; filterBy?: string } = {}
): Promise<PaginatedResponse<PoolSummary>> {
  const params = new URLSearchParams()
  if (opts.page) params.set('page', String(opts.page))
  if (opts.pageSize) params.set('page_size', String(opts.pageSize))
  if (opts.search) params.set('query', opts.search)
  if (opts.sortBy) params.set('sort_by', opts.sortBy)
  if (opts.filterBy) params.set('filter_by', opts.filterBy)

  const res = await fetchMeteora(network, '/pools', params)
  const body: MeteoraPagedResponse = await res.json()

  return {
    data: body.data.map((p) => mapPool(p, network)),
    total: body.total,
    pages: body.pages,
    currentPage: body.current_page,
    pageSize: body.page_size,
  }
}

export async function getPool(address: string, network: Network): Promise<PoolDetail | null> {
  try {
    const res = await fetchMeteora(network, `/pools/${address}`)
    const pool: MeteoraPool = await res.json()
    return mapPoolDetail(pool, network)
  } catch (err) {
    if (err instanceof MeteoraApiError && err.status === 404) return null
    throw err
  }
}

export async function listGroups(
  network: Network,
  opts: { page?: number; pageSize?: number } = {}
): Promise<PaginatedResponse<PoolGroup>> {
  const params = new URLSearchParams()
  if (opts.page) params.set('page', String(opts.page))
  if (opts.pageSize) params.set('page_size', String(opts.pageSize))

  const res = await fetchMeteora(network, '/pools/groups', params)
  const body = await res.json()

  return {
    data: (body.data ?? []).map((g: any) => ({
      name: g.name,
      pair: g.pair ?? `${g.mint_x} / ${g.mint_y}`,
      mintX: g.mint_x ?? g.lexical_order_mints?.split('-')[0],
      mintY: g.mint_y ?? g.lexical_order_mints?.split('-')[1],
      pools: (g.pools ?? []).map((p: MeteoraPool) => mapPool(p, network)),
      total: g.total ?? 0,
      pages: g.pages ?? 0,
      currentPage: g.current_page ?? 1,
    })),
    total: body.total ?? 0,
    pages: body.pages ?? 0,
    currentPage: body.current_page ?? 1,
    pageSize: body.page_size ?? 0,
  }
}

export async function getGroup(
  mintPair: string,
  network: Network,
  opts: { page?: number; pageSize?: number } = {}
): Promise<PoolGroup> {
  const params = new URLSearchParams()
  if (opts.page) params.set('page', String(opts.page))
  if (opts.pageSize) params.set('page_size', String(opts.pageSize))

  const res = await fetchMeteora(network, `/pools/groups/${mintPair}`, params)
  const body = await res.json()

  return {
    name: body.name ?? mintPair,
    pair: body.pair ?? mintPair,
    mintX: body.mint_x ?? mintPair.split('-')[0],
    mintY: body.mint_y ?? mintPair.split('-')[1],
    pools: (body.data ?? []).map((p: MeteoraPool) => mapPool(p, network)),
    total: body.total ?? 0,
    pages: body.pages ?? 0,
    currentPage: body.current_page ?? 1,
  }
}

export async function getOhlcv(
  address: string,
  network: Network,
  opts: { startTime?: number; endTime?: number; resolution?: string } = {}
): Promise<OhlcvCandle[]> {
  const params = new URLSearchParams()
  if (opts.startTime) params.set('start_time', String(opts.startTime))
  if (opts.endTime) params.set('end_time', String(opts.endTime))
  if (opts.resolution) params.set('resolution', opts.resolution)

  const res = await fetchMeteora(network, `/pools/${address}/ohlcv`, params)
  const body = await res.json()

  return (body.data ?? body ?? []).map((c: any) => ({
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    timestamp: c.timestamp,
  }))
}

export async function getVolumeHistory(
  address: string,
  network: Network,
  opts: { startTime?: number; endTime?: number; resolution?: string } = {}
): Promise<VolumeHistoryBucket[]> {
  const params = new URLSearchParams()
  if (opts.startTime) params.set('start_time', String(opts.startTime))
  if (opts.endTime) params.set('end_time', String(opts.endTime))
  if (opts.resolution) params.set('resolution', opts.resolution)

  const res = await fetchMeteora(network, `/pools/${address}/volume/history`, params)
  const body = await res.json()

  return (body.data ?? body ?? []).map((b: any) => ({
    timestamp: b.timestamp,
    volume: b.volume,
  }))
}

export async function getProtocolMetrics(network: Network): Promise<ProtocolMetrics> {
  const res = await fetchMeteora(network, '/stats/protocol_metrics')
  const body = await res.json()

  return {
    totalTvl: body.total_tvl,
    volume24h: body.volume_24h,
    fee24h: body.fee_24h,
    totalVolume: body.total_volume,
    totalFees: body.total_fees,
    totalPools: body.total_pools,
  }
}
