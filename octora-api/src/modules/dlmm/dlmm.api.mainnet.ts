/**
 * Meteora mainnet API client (`dlmm.datapi.meteora.ag`).
 *
 * Mainnet exposes a richer schema than devnet (denormalised pools with
 * pre-aggregated volume/fees buckets, groups endpoint, OHLCV, etc.).
 * Devnet lives in `./dlmm.api.devnet.ts` — the two shapes drift
 * independently so they're kept side-by-side, not unified.
 */
import { fetchMeteoraJson, MeteoraApiError } from './dlmm.api.shared.js'
import type {
  PoolSummary,
  PoolDetail,
  PoolGroup,
  OhlcvCandle,
  VolumeHistoryBucket,
  ProtocolMetrics,
  PaginatedResponse,
} from './dlmm.types.js'

interface MeteoraTokenMainnet {
  address: string
  symbol: string
  decimals: number
}

interface MeteoraPoolMainnet {
  address: string
  name: string
  token_x: MeteoraTokenMainnet
  token_y: MeteoraTokenMainnet
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

interface MeteoraPagedResponseMainnet {
  total: number
  pages: number
  current_page: number
  page_size: number
  data: MeteoraPoolMainnet[]
}

function mapPool(pool: MeteoraPoolMainnet): PoolSummary {
  return {
    address: pool.address,
    name: pool.name,
    pair: `${pool.token_x.symbol} / ${pool.token_y.symbol}`,
    tokenX: { symbol: pool.token_x.symbol, mint: pool.token_x.address, decimals: pool.token_x.decimals },
    tokenY: { symbol: pool.token_y.symbol, mint: pool.token_y.address, decimals: pool.token_y.decimals },
    tvl: pool.tvl,
    volume24h: pool.volume['24h'] ?? 0,
    fees24h: pool.fees['24h'] ?? 0,
    volumeByTf: pool.volume ?? {},
    feesByTf: pool.fees ?? {},
    apr: pool.apr,
    feeBps: pool.pool_config.base_fee_pct * 100,
    binStep: pool.pool_config.bin_step,
    baseFee: pool.pool_config.base_fee_pct,
    createdAt: pool.created_at ?? 0,
    network: 'mainnet',
    currentPrice: pool.current_price ?? 0,
    priceChange24h: 0,
  }
}

function mapPoolDetail(pool: MeteoraPoolMainnet): PoolDetail {
  return {
    ...mapPool(pool),
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

export async function listPoolsMainnet(
  opts: { search?: string; page?: number; pageSize?: number; sortBy?: string; filterBy?: string },
): Promise<PaginatedResponse<PoolSummary>> {
  const params = new URLSearchParams()
  if (opts.page) params.set('page', String(opts.page))
  if (opts.pageSize) params.set('page_size', String(opts.pageSize))
  if (opts.search) params.set('query', opts.search)
  if (opts.sortBy) params.set('sort_by', opts.sortBy)
  if (opts.filterBy) params.set('filter_by', opts.filterBy)

  const body = await fetchMeteoraJson<MeteoraPagedResponseMainnet>('mainnet', '/pools', params)

  return {
    data: body.data.map(mapPool),
    total: body.total,
    pages: body.pages,
    currentPage: body.current_page,
    pageSize: body.page_size,
  }
}

export async function getPoolMainnet(address: string): Promise<PoolDetail | null> {
  try {
    const pool = await fetchMeteoraJson<MeteoraPoolMainnet>('mainnet', `/pools/${address}`)
    return mapPoolDetail(pool)
  } catch (err) {
    if (err instanceof MeteoraApiError && err.status === 404) return null
    throw err
  }
}

export async function listGroupsMainnet(
  opts: { page?: number; pageSize?: number },
): Promise<PaginatedResponse<PoolGroup>> {
  const params = new URLSearchParams()
  if (opts.page) params.set('page', String(opts.page))
  if (opts.pageSize) params.set('page_size', String(opts.pageSize))

  const body = await fetchMeteoraJson<any>('mainnet', '/pools/groups', params)

  return {
    data: (body.data ?? []).map((g: any) => ({
      name: g.name,
      pair: g.pair ?? `${g.mint_x} / ${g.mint_y}`,
      mintX: g.mint_x ?? g.lexical_order_mints?.split('-')[0],
      mintY: g.mint_y ?? g.lexical_order_mints?.split('-')[1],
      pools: (g.pools ?? []).map((p: MeteoraPoolMainnet) => mapPool(p)),
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

export async function getGroupMainnet(
  mintPair: string,
  opts: { page?: number; pageSize?: number },
): Promise<PoolGroup> {
  const params = new URLSearchParams()
  if (opts.page) params.set('page', String(opts.page))
  if (opts.pageSize) params.set('page_size', String(opts.pageSize))

  const body = await fetchMeteoraJson<any>('mainnet', `/pools/groups/${mintPair}`, params)

  return {
    name: body.name ?? mintPair,
    pair: body.pair ?? mintPair,
    mintX: body.mint_x ?? mintPair.split('-')[0],
    mintY: body.mint_y ?? mintPair.split('-')[1],
    pools: (body.data ?? []).map((p: MeteoraPoolMainnet) => mapPool(p)),
    total: body.total ?? 0,
    pages: body.pages ?? 0,
    currentPage: body.current_page ?? 1,
  }
}

export async function getOhlcvMainnet(
  address: string,
  opts: { startTime?: number; endTime?: number; resolution?: string },
): Promise<OhlcvCandle[]> {
  const params = new URLSearchParams()
  if (opts.startTime) params.set('start_time', String(opts.startTime))
  if (opts.endTime) params.set('end_time', String(opts.endTime))
  if (opts.resolution) params.set('resolution', opts.resolution)

  const body = await fetchMeteoraJson<any>('mainnet', `/pools/${address}/ohlcv`, params)

  return (body.data ?? body ?? []).map((c: any) => ({
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    timestamp: c.timestamp,
  }))
}

export async function getVolumeHistoryMainnet(
  address: string,
  opts: { startTime?: number; endTime?: number; resolution?: string },
): Promise<VolumeHistoryBucket[]> {
  const params = new URLSearchParams()
  if (opts.startTime) params.set('start_time', String(opts.startTime))
  if (opts.endTime) params.set('end_time', String(opts.endTime))
  if (opts.resolution) params.set('resolution', opts.resolution)

  const body = await fetchMeteoraJson<any>('mainnet', `/pools/${address}/volume/history`, params)

  return (body.data ?? body ?? []).map((b: any) => ({
    timestamp: b.timestamp,
    volume: b.volume,
  }))
}

export async function getProtocolMetricsMainnet(): Promise<ProtocolMetrics> {
  const body = await fetchMeteoraJson<any>('mainnet', '/stats/protocol_metrics')
  return {
    totalTvl: body.total_tvl,
    volume24h: body.volume_24h,
    fee24h: body.fee_24h,
    totalVolume: body.total_volume,
    totalFees: body.total_fees,
    totalPools: body.total_pools,
  }
}

import type { DlmmIndexProvider } from './dlmm.provider.js'

export const mainnetDlmmIndex: DlmmIndexProvider = {
  listPools: listPoolsMainnet,
  getPool: getPoolMainnet,
  listGroups: listGroupsMainnet,
  getGroup: getGroupMainnet,
  getOhlcv: getOhlcvMainnet,
  getVolumeHistory: getVolumeHistoryMainnet,
  getProtocolMetrics: getProtocolMetricsMainnet,
}
