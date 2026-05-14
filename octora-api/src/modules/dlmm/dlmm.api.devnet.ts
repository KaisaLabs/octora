/**
 * Meteora devnet API client (`dlmm-api.devnet.meteora.ag`).
 *
 * Devnet's schema (PairInfo) differs from mainnet's pool schema — different
 * field names, fewer aggregates, and a deprecated `/pair/all` endpoint we
 * have to in-memory paginate because the typesense indices look empty.
 * Kept side-by-side with `./dlmm.api.mainnet.ts` so the two shapes can
 * drift independently.
 */
import { fetchMeteora, fetchMeteoraJson, MeteoraApiError } from './dlmm.api.shared.js'
import type {
  PoolSummary,
  PoolDetail,
  PoolGroup,
  VolumeHistoryBucket,
  ProtocolMetrics,
  PaginatedResponse,
  TokenInfo,
} from './dlmm.types.js'

interface MeteoraPairDevnet {
  address: string
  name: string
  mint_x: string
  mint_y: string
  reserve_x: string
  reserve_y: string
  reserve_x_amount: number
  reserve_y_amount: number
  bin_step: number
  base_fee_percentage: string
  max_fee_percentage: string
  protocol_fee_percentage: string
  /** Stringified TVL in USD (e.g. "1234.56"). */
  liquidity: string
  reward_mint_x: string
  reward_mint_y: string
  fees_24h: number
  today_fees: number
  trade_volume_24h: number
  cumulative_trade_volume: string
  cumulative_fee_volume: string
  current_price: number
  apr: number
  apy: number
  farm_apr: number
  farm_apy: number
  hide: boolean
  is_blacklisted: boolean
  is_verified?: boolean
  fees?: Record<string, number>
  fee_tvl_ratio?: Record<string, number>
  volume?: Record<string, number>
  tags?: string[]
  launchpad?: string | null
}

interface MeteoraGroupedPairsDevnet {
  groups: { name: string; pairs: MeteoraPairDevnet[] }[]
  total: number
}

interface MeteoraPagedPairsByGroupDevnet {
  total: number
  pages: number
  current_page: number
  page_size: number
  data: MeteoraPairDevnet[]
}

const KNOWN_DEVNET_MINTS: Record<string, { symbol: string; decimals: number }> = {
  So11111111111111111111111111111111111111112: { symbol: 'SOL', decimals: 9 },
}

function tokensFromPairName(name: string): [string, string] {
  const idx = name.indexOf('-')
  if (idx < 0) return [name || '?', '?']
  return [name.slice(0, idx) || '?', name.slice(idx + 1) || '?']
}

function tokenInfoDevnet(mint: string, fallbackSymbol: string): TokenInfo {
  const known = KNOWN_DEVNET_MINTS[mint]
  if (known) return { mint, symbol: known.symbol, decimals: known.decimals }
  const symbol = fallbackSymbol && fallbackSymbol !== '?' ? fallbackSymbol : mint.slice(0, 4)
  // Decimals not provided by the devnet API — default to 0. Bin/SDK paths
  // resolve real decimals on-chain when needed.
  return { mint, symbol, decimals: 0 }
}

function mapPool(p: MeteoraPairDevnet): PoolSummary {
  const [symX, symY] = tokensFromPairName(p.name ?? '')
  const tokenX = tokenInfoDevnet(p.mint_x, symX)
  const tokenY = tokenInfoDevnet(p.mint_y, symY)
  const baseFeePct = Number(p.base_fee_percentage) || 0
  const tvl = Number(p.liquidity) || 0
  return {
    address: p.address,
    name: p.name || `${tokenX.symbol}-${tokenY.symbol}`,
    pair: `${tokenX.symbol} / ${tokenY.symbol}`,
    tokenX,
    tokenY,
    tvl,
    volume24h: p.trade_volume_24h ?? 0,
    fees24h: p.fees_24h ?? 0,
    volumeByTf: p.volume ?? { '24h': p.trade_volume_24h ?? 0 },
    feesByTf: p.fees ?? { '24h': p.fees_24h ?? 0 },
    apr: p.apr ?? 0,
    feeBps: baseFeePct * 100,
    binStep: p.bin_step,
    baseFee: baseFeePct,
    createdAt: 0,
    network: 'devnet',
    currentPrice: p.current_price ?? 0,
    priceChange24h: 0,
  }
}

function mapPoolDetail(p: MeteoraPairDevnet): PoolDetail {
  const summary = mapPool(p)
  const baseFeePct = Number(p.base_fee_percentage) || 0
  const maxFeePct = Number(p.max_fee_percentage) || 0
  const protocolFeePct = Number(p.protocol_fee_percentage) || 0
  return {
    ...summary,
    activeBinId: 0,
    price: p.current_price ?? 0,
    priceRange: { min: 0, max: 0 },
    liquidityShape: 'spot',
    totalLiquidity: summary.tvl,
    feeInfo: {
      baseFeeBps: baseFeePct * 100,
      maxFeeBps: maxFeePct * 100,
      protocolFeeBps: protocolFeePct * 100,
    },
  }
}

// Devnet's `/pair/all_with_pagination` and `/pair/all_by_groups_2` both return
// `{ total: <large>, pairs|groups: [] }` — the typesense-backed indices appear
// unpopulated. The deprecated `/pair/all` endpoint still returns the full set
// (~8k pairs at time of writing), so we use it and paginate/filter in-memory.
const DEVNET_PAIRS_TTL_MS = 30_000
let devnetPairsCache: { fetchedAt: number; pairs: MeteoraPairDevnet[] } | null = null

async function fetchAllDevnetPairs(): Promise<MeteoraPairDevnet[]> {
  if (devnetPairsCache && Date.now() - devnetPairsCache.fetchedAt < DEVNET_PAIRS_TTL_MS) {
    return devnetPairsCache.pairs
  }
  const params = new URLSearchParams()
  params.set('include_unknown', 'true')
  const res = await fetchMeteora('devnet', '/pair/all', params)
  const body = (await res.json()) as MeteoraPairDevnet[] | { data?: MeteoraPairDevnet[] }
  const pairs = Array.isArray(body) ? body : (body.data ?? [])
  devnetPairsCache = { fetchedAt: Date.now(), pairs }
  return pairs
}

function devnetPairMatchesSearch(p: MeteoraPairDevnet, query: string): boolean {
  const q = query.toLowerCase()
  return (
    p.address.toLowerCase().includes(q) ||
    (p.name ?? '').toLowerCase().includes(q) ||
    p.mint_x.toLowerCase().includes(q) ||
    p.mint_y.toLowerCase().includes(q)
  )
}

function devnetSortKey(p: MeteoraPairDevnet, key: string): number {
  switch (key) {
    case 'volume':
    case 'volume24h':
    case 'trade_volume_24h':
      return p.trade_volume_24h ?? 0
    case 'fees':
    case 'fees24h':
      return p.fees_24h ?? 0
    case 'apr':
      return p.apr ?? 0
    case 'binStep':
    case 'bin_step':
      return p.bin_step ?? 0
    case 'tvl':
    case 'liquidity':
    default:
      return Number(p.liquidity) || 0
  }
}

export async function listPoolsDevnet(
  opts: { search?: string; page?: number; pageSize?: number; sortBy?: string; filterBy?: string },
): Promise<PaginatedResponse<PoolSummary>> {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.max(1, opts.pageSize ?? 50)

  const all = await fetchAllDevnetPairs()
  const filtered = opts.search ? all.filter((p) => devnetPairMatchesSearch(p, opts.search!)) : all.slice()

  const sortBy = opts.sortBy ?? 'tvl'
  const ascending = (opts.filterBy ?? '').toLowerCase() === 'asc'
  filtered.sort((a, b) => {
    const av = devnetSortKey(a, sortBy)
    const bv = devnetSortKey(b, sortBy)
    return ascending ? av - bv : bv - av
  })

  const total = filtered.length
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const start = (page - 1) * pageSize
  const slice = filtered.slice(start, start + pageSize)

  return {
    data: slice.map(mapPool),
    total,
    pages,
    currentPage: page,
    pageSize,
  }
}

export async function getPoolDevnet(address: string): Promise<PoolDetail | null> {
  try {
    const pair = await fetchMeteoraJson<MeteoraPairDevnet>('devnet', `/pair/${address}`)
    return mapPoolDetail(pair)
  } catch (err) {
    if (err instanceof MeteoraApiError && err.status === 404) return null
    throw err
  }
}

export async function listGroupsDevnet(
  opts: { page?: number; pageSize?: number },
): Promise<PaginatedResponse<PoolGroup>> {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.max(1, opts.pageSize ?? 50)
  const params = new URLSearchParams()
  params.set('page', String(page - 1))
  params.set('limit', String(pageSize))
  params.set('include_unknown', 'true')

  const body = await fetchMeteoraJson<MeteoraGroupedPairsDevnet>(
    'devnet',
    '/pair/all_by_groups',
    params,
  )

  const total = body.total ?? 0
  const pages = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1

  return {
    data: (body.groups ?? []).map((g) => {
      const first = g.pairs[0]
      return {
        name: g.name,
        pair: g.name,
        mintX: first?.mint_x ?? '',
        mintY: first?.mint_y ?? '',
        pools: g.pairs.map(mapPool),
        total: g.pairs.length,
        pages: 1,
        currentPage: 1,
      }
    }),
    total,
    pages,
    currentPage: page,
    pageSize,
  }
}

export async function getGroupDevnet(
  mintPair: string,
  opts: { page?: number; pageSize?: number },
): Promise<PoolGroup> {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.max(1, opts.pageSize ?? 50)
  const params = new URLSearchParams()
  params.set('page', String(page))
  params.set('per_page', String(pageSize))

  const body = await fetchMeteoraJson<MeteoraPagedPairsByGroupDevnet>(
    'devnet',
    `/pair/groups/${mintPair}`,
    params,
  )
  const rawPairs = body.data ?? []
  const first = rawPairs[0]

  return {
    name: mintPair,
    pair: mintPair,
    mintX: first?.mint_x ?? mintPair.split('-')[0] ?? '',
    mintY: first?.mint_y ?? mintPair.split('-')[1] ?? '',
    pools: rawPairs.map(mapPool),
    total: body.total ?? rawPairs.length,
    pages: body.pages ?? Math.max(1, Math.ceil((body.total ?? rawPairs.length) / pageSize)),
    currentPage: body.current_page ?? page,
  }
}

export async function getVolumeHistoryDevnet(
  address: string,
  opts: { startTime?: number; endTime?: number; resolution?: string },
): Promise<VolumeHistoryBucket[]> {
  // Devnet exposes daily volume buckets via the analytics endpoint. Convert
  // an optional [startTime, endTime] window in unix-seconds into a day count.
  const numDays = (() => {
    if (opts.startTime && opts.endTime) {
      return Math.max(1, Math.min(255, Math.ceil((opts.endTime - opts.startTime) / 86_400)))
    }
    return 30
  })()
  const params = new URLSearchParams()
  params.set('num_of_days', String(numDays))

  const body = await fetchMeteoraJson<any>(
    'devnet',
    `/pair/${address}/analytic/pair_trade_volume`,
    params,
  )
  const rows: any[] = Array.isArray(body) ? body : (body.data ?? [])

  return rows.map((r) => ({
    timestamp: typeof r.day_date === 'string' ? Math.floor(new Date(r.day_date).getTime() / 1000) : Number(r.day_date) || 0,
    volume: Number(r.trade_volume) || 0,
  }))
}

export async function getProtocolMetricsDevnet(): Promise<ProtocolMetrics> {
  const raw = await fetchMeteoraJson<any>('devnet', '/info/protocol_metrics')
  // The endpoint occasionally returns `[obj]` or a bare object — handle both.
  const body = Array.isArray(raw) ? raw[0] ?? {} : raw
  return {
    totalTvl: Number(body.total_tvl) || 0,
    volume24h: Number(body.daily_trade_volume) || 0,
    fee24h: Number(body.daily_fee) || 0,
    totalVolume: Number(body.total_trade_volume) || 0,
    totalFees: Number(body.total_fee) || 0,
    totalPools: 0,
  }
}
