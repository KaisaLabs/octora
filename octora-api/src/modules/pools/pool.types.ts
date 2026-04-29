export interface PoolSummary {
  address: string
  name: string
  pair: string
  tokenX: { symbol: string; mint: string; decimals: number }
  tokenY: { symbol: string; mint: string; decimals: number }
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
