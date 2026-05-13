import { Connection, PublicKey } from '@solana/web3.js'
import DLMM from '@meteora-ag/dlmm'
import { BN } from '@coral-xyz/anchor'
import { UpstreamError } from '#common/errors'
import { loadConfig } from '#common/config'
import type {
  PoolSummary,
  PoolDetail,
  PoolGroup,
  OhlcvCandle,
  VolumeHistoryBucket,
  ProtocolMetrics,
  PaginatedResponse,
  PoolBins,
  LiquidityBin,
  TokenInfo,
} from './dlmm.types'

// Mainnet (`dlmm.datapi.meteora.ag`) and devnet (`dlmm-api.devnet.meteora.ag`)
// expose two completely different APIs with different paths and field names.
// The two are kept side-by-side and dispatched per call. `localnet` has no
// hosted indexer — every call falls through to the chain-direct path that
// reads lb_pair / mint accounts from the local validator's RPC.
const API_BASE = {
  mainnet: 'https://dlmm.datapi.meteora.ag',
  devnet: 'https://dlmm-api.devnet.meteora.ag',
} as const

export type Network = 'mainnet' | 'devnet' | 'localnet'

async function fetchMeteora(network: Network, path: string, params?: URLSearchParams): Promise<Response> {
  if (network === 'localnet') {
    throw new MeteoraApiError(
      501,
      `Meteora indexer not available on localnet (path=${path}); use the chain-direct path`,
    )
  }
  const base = API_BASE[network]
  const qs = params?.toString()
  const url = qs ? `${base}${path}?${qs}` : `${base}${path}`

  const res = await fetch(url)
  if (!res.ok) {
    throw new MeteoraApiError(res.status, `Meteora API error: ${res.status}`)
  }
  return res
}

export class MeteoraApiError extends UpstreamError {
  constructor(public status: number, message: string) {
    super(message, { code: 'meteora_upstream_error', details: { upstreamStatus: status } })
    this.name = 'MeteoraApiError'
  }
}

// ─────────────────────────────────────────────────────────────────────
// Mainnet API shape
// ─────────────────────────────────────────────────────────────────────

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

function mapPoolMainnet(pool: MeteoraPoolMainnet, network: Network): PoolSummary {
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
    network,
  }
}

function mapPoolDetailMainnet(pool: MeteoraPoolMainnet, network: Network): PoolDetail {
  return {
    ...mapPoolMainnet(pool, network),
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

// ─────────────────────────────────────────────────────────────────────
// Devnet API shape (PairInfo)
// ─────────────────────────────────────────────────────────────────────

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

function mapPoolDevnet(p: MeteoraPairDevnet, network: Network): PoolSummary {
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
    network,
  }
}

function mapPoolDetailDevnet(p: MeteoraPairDevnet, network: Network): PoolDetail {
  const summary = mapPoolDevnet(p, network)
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

// ─────────────────────────────────────────────────────────────────────
// Public API — dispatches by network
// ─────────────────────────────────────────────────────────────────────

export async function listPools(
  network: Network,
  opts: { search?: string; page?: number; pageSize?: number; sortBy?: string; filterBy?: string } = {}
): Promise<PaginatedResponse<PoolSummary>> {
  if (network === 'localnet') {
    // No hosted indexer for localnet — the browser navigates by pool address
    // directly. Return empty so the listing UI renders without errors.
    return { data: [], total: 0, pages: 0, currentPage: 1, pageSize: opts.pageSize ?? 50 }
  }
  if (network === 'devnet') return listPoolsDevnet(opts)

  const params = new URLSearchParams()
  if (opts.page) params.set('page', String(opts.page))
  if (opts.pageSize) params.set('page_size', String(opts.pageSize))
  if (opts.search) params.set('query', opts.search)
  if (opts.sortBy) params.set('sort_by', opts.sortBy)
  if (opts.filterBy) params.set('filter_by', opts.filterBy)

  const res = await fetchMeteora(network, '/pools', params)
  const body: MeteoraPagedResponseMainnet = await res.json()

  return {
    data: body.data.map((p) => mapPoolMainnet(p, network)),
    total: body.total,
    pages: body.pages,
    currentPage: body.current_page,
    pageSize: body.page_size,
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

async function listPoolsDevnet(
  opts: { search?: string; page?: number; pageSize?: number; sortBy?: string; filterBy?: string }
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
    data: slice.map((p) => mapPoolDevnet(p, 'devnet')),
    total,
    pages,
    currentPage: page,
    pageSize,
  }
}

export async function getPool(address: string, network: Network): Promise<PoolDetail | null> {
  try {
    if (network === 'localnet') {
      return await getPoolFromChain(address, network)
    }
    if (network === 'devnet') {
      const res = await fetchMeteora('devnet', `/pair/${address}`)
      const pair: MeteoraPairDevnet = await res.json()
      return mapPoolDetailDevnet(pair, 'devnet')
    }
    const res = await fetchMeteora(network, `/pools/${address}`)
    const pool: MeteoraPoolMainnet = await res.json()
    return mapPoolDetailMainnet(pool, network)
  } catch (err) {
    if (err instanceof MeteoraApiError && err.status === 404) return null
    throw err
  }
}

export async function listGroups(
  network: Network,
  opts: { page?: number; pageSize?: number } = {}
): Promise<PaginatedResponse<PoolGroup>> {
  if (network === 'localnet') {
    return { data: [], total: 0, pages: 0, currentPage: 1, pageSize: opts.pageSize ?? 50 }
  }
  if (network === 'devnet') return listGroupsDevnet(opts)

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
      pools: (g.pools ?? []).map((p: MeteoraPoolMainnet) => mapPoolMainnet(p, network)),
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

async function listGroupsDevnet(
  opts: { page?: number; pageSize?: number }
): Promise<PaginatedResponse<PoolGroup>> {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.max(1, opts.pageSize ?? 50)
  const params = new URLSearchParams()
  params.set('page', String(page - 1))
  params.set('limit', String(pageSize))
  params.set('include_unknown', 'true')

  const res = await fetchMeteora('devnet', '/pair/all_by_groups', params)
  const body: MeteoraGroupedPairsDevnet = await res.json()

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
        pools: g.pairs.map((p) => mapPoolDevnet(p, 'devnet')),
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

export async function getGroup(
  mintPair: string,
  network: Network,
  opts: { page?: number; pageSize?: number } = {}
): Promise<PoolGroup> {
  if (network === 'localnet') {
    return {
      name: mintPair,
      pair: mintPair,
      mintX: '',
      mintY: '',
      pools: [],
      total: 0,
      pages: 0,
      currentPage: 1,
    }
  }
  if (network === 'devnet') return getGroupDevnet(mintPair, opts)

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
    pools: (body.data ?? []).map((p: MeteoraPoolMainnet) => mapPoolMainnet(p, network)),
    total: body.total ?? 0,
    pages: body.pages ?? 0,
    currentPage: body.current_page ?? 1,
  }
}

async function getGroupDevnet(
  mintPair: string,
  opts: { page?: number; pageSize?: number }
): Promise<PoolGroup> {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.max(1, opts.pageSize ?? 50)
  const params = new URLSearchParams()
  params.set('page', String(page))
  params.set('per_page', String(pageSize))

  const res = await fetchMeteora('devnet', `/pair/groups/${mintPair}`, params)
  const body: MeteoraPagedPairsByGroupDevnet = await res.json()
  const rawPairs = body.data ?? []
  const first = rawPairs[0]

  return {
    name: mintPair,
    pair: mintPair,
    mintX: first?.mint_x ?? mintPair.split('-')[0] ?? '',
    mintY: first?.mint_y ?? mintPair.split('-')[1] ?? '',
    pools: rawPairs.map((p) => mapPoolDevnet(p, 'devnet')),
    total: body.total ?? rawPairs.length,
    pages: body.pages ?? Math.max(1, Math.ceil((body.total ?? rawPairs.length) / pageSize)),
    currentPage: body.current_page ?? page,
  }
}

export async function getOhlcv(
  address: string,
  network: Network,
  opts: { startTime?: number; endTime?: number; resolution?: string } = {}
): Promise<OhlcvCandle[]> {
  // Devnet/localnet have no OHLCV endpoint. Return empty rather than 404
  // so the UI can render its empty/fallback state.
  if (network === 'devnet' || network === 'localnet') return []

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
  if (network === 'localnet') return []
  if (network === 'devnet') return getVolumeHistoryDevnet(address, opts)

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

async function getVolumeHistoryDevnet(
  address: string,
  opts: { startTime?: number; endTime?: number; resolution?: string }
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

  const res = await fetchMeteora('devnet', `/pair/${address}/analytic/pair_trade_volume`, params)
  const body = await res.json()
  const rows: any[] = Array.isArray(body) ? body : (body.data ?? [])

  return rows.map((r) => ({
    timestamp: typeof r.day_date === 'string' ? Math.floor(new Date(r.day_date).getTime() / 1000) : Number(r.day_date) || 0,
    volume: Number(r.trade_volume) || 0,
  }))
}

export async function getProtocolMetrics(network: Network): Promise<ProtocolMetrics> {
  if (network === 'localnet') {
    return { totalTvl: 0, volume24h: 0, fee24h: 0, totalVolume: 0, totalFees: 0, totalPools: 0 }
  }
  if (network === 'devnet') {
    const res = await fetchMeteora('devnet', '/info/protocol_metrics')
    const raw = await res.json()
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

// ─────────────────────────────────────────────────────────────────────
// On-chain bin reading via @meteora-ag/dlmm — network-agnostic
// ─────────────────────────────────────────────────────────────────────

const RPC_URL: Record<Network, string> = loadConfig().dlmmRpcUrls

const connections: Partial<Record<Network, Connection>> = {}
function getConnection(network: Network): Connection {
  let conn = connections[network]
  if (!conn) {
    conn = new Connection(RPC_URL[network], 'confirmed')
    connections[network] = conn
  }
  return conn
}

interface CachedDlmm {
  instance: any
  createdAt: number
}

const DLMM_CACHE_TTL_MS = 30_000
const dlmmCache = new Map<string, CachedDlmm>()

async function getDlmmInstance(address: string, network: Network) {
  const key = `${network}:${address}`
  const cached = dlmmCache.get(key)
  if (cached && Date.now() - cached.createdAt < DLMM_CACHE_TTL_MS) {
    return cached.instance
  }
  const conn = getConnection(network)
  const instance = await (DLMM as any).create(conn, new PublicKey(address))
  dlmmCache.set(key, { instance, createdAt: Date.now() })
  return instance
}

export async function getPoolBins(
  address: string,
  network: Network,
  opts: { count?: number } = {},
): Promise<PoolBins> {
  const count = Math.max(7, Math.min(opts.count ?? 61, 201))
  const half = Math.floor(count / 2)

  let dlmm: any
  try {
    dlmm = await getDlmmInstance(address, network)
  } catch (err: any) {
    throw new MeteoraApiError(404, `DLMM pool not found: ${err?.message ?? String(err)}`)
  }

  const { activeBin, bins } = (await dlmm.getBinsAroundActiveBin(half, half)) as {
    activeBin: number
    bins: Array<{ binId: number; price: string; xAmount: any; yAmount: any }>
  }

  const tokenXDecimals: number = dlmm.tokenX?.mint?.decimals ?? dlmm.tokenX?.decimals ?? 0
  const tokenYDecimals: number = dlmm.tokenY?.mint?.decimals ?? dlmm.tokenY?.decimals ?? 0
  const binStep: number = dlmm.lbPair?.binStep ?? 0

  const out: LiquidityBin[] = bins.map((b) => {
    const price = Number(b.price)
    const x = decimalize(b.xAmount, tokenXDecimals)
    const y = decimalize(b.yAmount, tokenYDecimals)
    const liquidity = y + (Number.isFinite(price) ? x * price : 0)
    return {
      binId: b.binId,
      price,
      liquidity,
      xAmount: bnToString(b.xAmount),
      yAmount: bnToString(b.yAmount),
    }
  })

  return {
    address,
    network,
    activeBinId: activeBin,
    binStep,
    bins: out,
  }
}

function decimalize(raw: any, decimals: number): number {
  if (raw == null) return 0
  const s = typeof raw === 'string' ? raw : raw.toString?.() ?? String(raw)
  const n = Number(s)
  if (!Number.isFinite(n)) return 0
  return n / Math.pow(10, decimals || 0)
}

function bnToString(raw: any): string {
  if (raw == null) return '0'
  return typeof raw === 'string' ? raw : raw.toString?.() ?? String(raw)
}

// ─────────────────────────────────────────────────────────────────────
// Chain-direct PoolDetail (localnet, where Meteora's indexer is absent)
// ─────────────────────────────────────────────────────────────────────

async function getPoolFromChain(address: string, network: Network): Promise<PoolDetail | null> {
  let dlmm: any
  try {
    dlmm = await getDlmmInstance(address, network)
  } catch {
    return null
  }
  const conn = getConnection(network)
  const lbPair: any = dlmm.lbPair
  const tokenXMint: PublicKey = dlmm.tokenX?.publicKey ?? new PublicKey(lbPair.tokenXMint)
  const tokenYMint: PublicKey = dlmm.tokenY?.publicKey ?? new PublicKey(lbPair.tokenYMint)

  const [xDecimals, yDecimals] = await Promise.all([
    fetchMintDecimals(conn, tokenXMint, dlmm.tokenX?.mint?.decimals ?? dlmm.tokenX?.decimals),
    fetchMintDecimals(conn, tokenYMint, dlmm.tokenY?.mint?.decimals ?? dlmm.tokenY?.decimals),
  ])

  const xSymbol = labelForMint(tokenXMint)
  const ySymbol = labelForMint(tokenYMint)
  const binStep = Number(lbPair.binStep ?? 0)
  const baseFactor = Number(lbPair.parameters?.baseFactor ?? 0)
  const baseFeeBps = Math.round((baseFactor * binStep) / 100)
  const activeBinId = Number(lbPair.activeId ?? 0)

  // Active bin price in tokenY-per-tokenX, scaled per the binStep formula:
  //   price = (1 + binStep/10_000) ** activeId
  const price = Math.pow(1 + binStep / 10_000, activeBinId)

  return {
    address,
    name: `${xSymbol}-${ySymbol}`,
    pair: `${xSymbol}/${ySymbol}`,
    tokenX: { symbol: xSymbol, mint: tokenXMint.toBase58(), decimals: xDecimals },
    tokenY: { symbol: ySymbol, mint: tokenYMint.toBase58(), decimals: yDecimals },
    tvl: 0,
    volume24h: 0,
    fees24h: 0,
    volumeByTf: {},
    feesByTf: {},
    apr: 0,
    feeBps: baseFeeBps,
    binStep,
    baseFee: baseFeeBps,
    createdAt: 0,
    network,
    activeBinId,
    price,
    priceRange: { min: 0, max: 0 },
    liquidityShape: 'unknown',
    totalLiquidity: 0,
    feeInfo: {
      baseFeeBps,
      maxFeeBps: baseFeeBps,
      protocolFeeBps: Number(lbPair.parameters?.protocolShare ?? 0),
    },
  }
}

async function fetchMintDecimals(
  conn: Connection,
  mint: PublicKey,
  fallback: number | undefined,
): Promise<number> {
  if (typeof fallback === 'number') return fallback
  const acct = await conn.getAccountInfo(mint, 'confirmed')
  if (!acct || acct.data.length < 45) return 0
  // SPL mint layout: decimals at byte 44 (after mintAuthority option + supply).
  return acct.data[44]
}

function labelForMint(mint: PublicKey): string {
  const NATIVE_MINT_BS58 = 'So11111111111111111111111111111111111111112'
  if (mint.toBase58() === NATIVE_MINT_BS58) return 'SOL'
  return mint.toBase58().slice(0, 4)
}

export interface SwapQuoteResult {
  /** Lamports the user is paying in. Echoed back for caller sanity-check. */
  amountIn: string
  /** Lamports the user receives after fees and slippage (pre-slippage estimate). */
  expectedOut: string
  /** Lamports the user is guaranteed to receive (after `allowedSlippageBps`). */
  minOut: string
  /** Slippage tolerance the quote was computed with, in BPS. */
  allowedSlippageBps: number
  /** Lamports of the input the swap actually consumed (partial fills possible). */
  consumedIn: string
  /** Total fee paid in output-token lamports. */
  feeLamports: string
  /** Decimal price impact, e.g. "0.0124" for 1.24 %. */
  priceImpact: string
  /** End price after the swap (output-token-per-input-token). */
  endPrice: string
  /** Direction echoed back: tokenX → tokenY when true. */
  swapForY: boolean
}

/**
 * Compute an unsigned swap quote against a DLMM pool.
 *
 * The browser orchestrators (privateExit, privateClaim) call this to learn
 * how much SOL their stealth-held non-SOL balance will yield before they
 * build the on-chain `dlmm_swap` tx — without an accurate quote the
 * `min_amount_out` arg has to be set to 1 (no protection) or a placeholder
 * that misreads tokens with non-unit per-lamport value, causing every swap
 * for real meme tokens to revert.
 *
 * Wraps Meteora SDK's `swapQuote`. Returns lamports as decimal strings so
 * the browser doesn't have to handle BNs.
 */
export async function getSwapQuote(
  poolAddress: string,
  network: Network,
  opts: {
    amountIn: bigint
    swapForY: boolean
    allowedSlippageBps?: number
  },
): Promise<SwapQuoteResult> {
  const allowedSlippageBps = Math.max(0, Math.min(opts.allowedSlippageBps ?? 500, 2000))
  let dlmm: any
  try {
    dlmm = await getDlmmInstance(poolAddress, network)
  } catch (err: any) {
    throw new MeteoraApiError(404, `DLMM pool not found: ${err?.message ?? String(err)}`)
  }

  // Pull a window of bin arrays around the active bin. `getBinArrayForSwap`
  // walks outward from the active bin in the direction the swap will move
  // the price, so the SDK's quote routine sees enough liquidity to reach
  // the requested input size without an out-of-bins error on big swaps.
  const binArrays = await dlmm.getBinArrayForSwap(opts.swapForY, 4)

  const inAmountBn = new BN(opts.amountIn.toString())
  const allowedSlippageBn = new BN(allowedSlippageBps)

  let quote: any
  try {
    quote = dlmm.swapQuote(inAmountBn, opts.swapForY, allowedSlippageBn, binArrays, false)
  } catch (err: any) {
    throw new MeteoraApiError(
      422,
      `Swap quote failed: ${err?.message ?? String(err)}. ` +
        'Pool may have insufficient liquidity in the requested direction.',
    )
  }

  return {
    amountIn: opts.amountIn.toString(),
    expectedOut: quote.outAmount.toString(),
    minOut: quote.minOutAmount.toString(),
    allowedSlippageBps,
    consumedIn: quote.consumedInAmount.toString(),
    feeLamports: quote.fee.toString(),
    priceImpact: quote.priceImpact.toString(),
    endPrice: quote.endPrice.toString(),
    swapForY: opts.swapForY,
  }
}
