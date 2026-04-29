export interface TokenInfo {
  symbol: string
  mint: string
  decimals: number
}

export interface PoolSummary {
  address: string
  name: string
  pair: string
  tokenX: TokenInfo
  tokenY: TokenInfo
  tvl: number
  volume24h: number
  fees24h: number
  apr: number
  feeBps: number
  binStep: number
  baseFee: number
  network: 'mainnet' | 'devnet'
}

export interface PoolDetail extends PoolSummary {
  activeBinId: number
  price: number
  priceRange: { min: number; max: number }
  liquidityShape: string
  totalLiquidity: number
  feeInfo: {
    baseFeeBps: number
    maxFeeBps: number
    protocolFeeBps: number
  }
}

export interface PoolGroup {
  name: string
  pair: string
  mintX: string
  mintY: string
  pools: PoolSummary[]
  total: number
  pages: number
  currentPage: number
}

export interface OhlcvCandle {
  open: number
  high: number
  low: number
  close: number
  volume: number
  timestamp: number
}

export interface VolumeHistoryBucket {
  timestamp: number
  volume: number
}

export interface ProtocolMetrics {
  totalTvl: number
  volume24h: number
  fee24h: number
  totalVolume: number
  totalFees: number
  totalPools: number
}

export interface PaginatedResponse<T> {
  data: T[]
  total: number
  pages: number
  currentPage: number
  pageSize: number
}
