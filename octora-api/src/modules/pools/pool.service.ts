import type { PoolDetail, PoolSummary } from './pool.types'

const API_BASE = {
  mainnet: 'https://dlmm.datapi.meteora.ag',
  devnet: 'https://dlmm-api.devnet.meteora.ag',
}

interface MeteoraPoolResponse {
  total: number
  pages: number
  current_page: number
  page_size: number
  data: MeteoraPool[]
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
  volume: {
    '24h': number
  }
  fees: {
    '24h': number
  }
  dynamic_fee_pct: number
  created_at: number
}

interface MeteoraToken {
  address: string
  symbol: string
  decimals: number
}

export async function listPools(
  network: 'mainnet' | 'devnet' = 'mainnet',
  opts: { search?: string; limit?: number; offset?: number } = {}
): Promise<PoolSummary[]> {
  const base = API_BASE[network]
  const limit = opts.limit ?? 50
  const page = Math.floor((opts.offset ?? 0) / limit) + 1

  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('page', String(page))
  if (opts.search) params.set('search', opts.search)

  const res = await fetch(`${base}/pools?${params.toString()}`)
  if (!res.ok) {
    throw new Error(`Meteora API error: ${res.status}`)
  }

  const data: MeteoraPoolResponse = await res.json()

  return data.data.map((pool) => ({
    address: pool.address,
    name: pool.name,
    pair: `${pool.token_x.symbol} / ${pool.token_y.symbol}`,
    tokenX: {
      symbol: pool.token_x.symbol,
      mint: pool.token_x.address,
      decimals: pool.token_x.decimals,
    },
    tokenY: {
      symbol: pool.token_y.symbol,
      mint: pool.token_y.address,
      decimals: pool.token_y.decimals,
    },
    tvl: pool.tvl,
    volume24h: pool.volume['24h'],
    fees24h: pool.fees['24h'],
    apr: pool.apr,
    feeBps: pool.pool_config.base_fee_pct * 100,
    binStep: pool.pool_config.bin_step,
    baseFee: pool.pool_config.base_fee_pct,
    network,
  }))
}

export async function getPoolDetail(
  address: string,
  network: 'mainnet' | 'devnet' = 'mainnet'
): Promise<PoolDetail | null> {
  try {
    const base = API_BASE[network]
    const res = await fetch(`${base}/pools/${address}`)

    if (!res.ok) {
      if (res.status === 404) return null
      throw new Error(`Meteora API error: ${res.status}`)
    }

    const pool: MeteoraPool = await res.json()

    return {
      address: pool.address,
      name: pool.name,
      pair: `${pool.token_x.symbol} / ${pool.token_y.symbol}`,
      tokenX: {
        symbol: pool.token_x.symbol,
        mint: pool.token_x.address,
        decimals: pool.token_x.decimals,
      },
      tokenY: {
        symbol: pool.token_y.symbol,
        mint: pool.token_y.address,
        decimals: pool.token_y.decimals,
      },
      tvl: pool.tvl,
      volume24h: pool.volume['24h'],
      fees24h: pool.fees['24h'],
      apr: pool.apr,
      feeBps: pool.pool_config.base_fee_pct * 100,
      binStep: pool.pool_config.bin_step,
      baseFee: pool.pool_config.base_fee_pct,
      network,
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
  } catch {
    return null
  }
}
