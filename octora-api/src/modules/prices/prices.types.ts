export interface PriceInfo {
  /** USD price per whole token. */
  usdPrice: number
  /** % change vs 24h ago. */
  priceChange24h: number
  decimals: number
  /** Solana slot the price was computed at; useful for recency comparisons. */
  blockId: number
  /** ISO timestamp of the underlying feed. */
  createdAt: string
}

/** Map of mint -> PriceInfo. Mints with no price route are omitted. */
export type PriceMap = Record<string, PriceInfo>
