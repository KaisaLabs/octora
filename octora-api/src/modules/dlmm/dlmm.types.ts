export type Network = 'mainnet' | 'devnet' | 'localnet'

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
  /**
   * Volume/fees buckets keyed by timeframe label ("5m", "30m", "1h", "2h",
   * "4h", "12h", "24h") in raw USD. Mainnet exposes the full set; devnet only
   * provides 24h so the map degrades to `{ "24h": <n> }`.
   */
  volumeByTf: Record<string, number>
  feesByTf: Record<string, number>
  apr: number
  feeBps: number
  binStep: number
  baseFee: number
  /** Unix seconds from Meteora; 0 if unavailable. */
  createdAt: number
  network: 'mainnet' | 'devnet' | 'localnet'
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

export interface LiquidityBin {
  binId: number
  /** Price denominated in tokenY per tokenX, scaled per Meteora SDK. */
  price: number
  /** Aggregate liquidity in the bin, in USD-ish units (xAmount + yAmount converted via current price). */
  liquidity: number
  xAmount: string
  yAmount: string
}

export interface PoolBins {
  address: string
  network: 'mainnet' | 'devnet' | 'localnet'
  activeBinId: number
  binStep: number
  bins: LiquidityBin[]
}
