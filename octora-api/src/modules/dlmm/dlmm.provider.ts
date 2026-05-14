/**
 * DLMM index provider seam. Three siblings used to dispatch by network
 * inside `dlmm.service.ts` without a shared interface — when commit
 * e0a1cd7 unified `currentPrice` across mainnet / devnet / chain, every
 * adapter had to be hand-edited and the type system couldn't catch a
 * missed one. This interface makes that mistake a compile error.
 *
 * Three implementations:
 *   - mainnetDlmmIndex   — hosted `dlmm.datapi.meteora.ag` (in dlmm.api.mainnet)
 *   - devnetDlmmIndex    — hosted devnet API           (in dlmm.api.devnet)
 *   - localnetDlmmIndex  — empty/stub                  (this file)
 *
 * Chain-direct reads (`getPoolBins`, `getSwapQuote`, `getPoolFromChain`)
 * deliberately live elsewhere — they're a *different* operation set,
 * not parallel impls of these methods. Keeping them separate avoids
 * smuggling a no-Connection wrapper into adapters that only need HTTP.
 */
import type {
  PoolSummary,
  PoolDetail,
  PoolGroup,
  OhlcvCandle,
  VolumeHistoryBucket,
  ProtocolMetrics,
  PaginatedResponse,
} from './dlmm.types.js'

export interface ListPoolsOpts {
  search?: string
  page?: number
  pageSize?: number
  sortBy?: string
  filterBy?: string
}

export interface DlmmIndexProvider {
  listPools(opts: ListPoolsOpts): Promise<PaginatedResponse<PoolSummary>>
  getPool(address: string): Promise<PoolDetail | null>
  listGroups(opts: { page?: number; pageSize?: number }): Promise<PaginatedResponse<PoolGroup>>
  getGroup(mintPair: string, opts: { page?: number; pageSize?: number }): Promise<PoolGroup>
  /**
   * OHLCV candles. Devnet + localnet return `[]` since neither indexer
   * publishes the series — keeping the method required (not optional)
   * lets callers skip a runtime feature-detection branch.
   */
  getOhlcv(
    address: string,
    opts: { startTime?: number; endTime?: number; resolution?: string },
  ): Promise<OhlcvCandle[]>
  getVolumeHistory(
    address: string,
    opts: { startTime?: number; endTime?: number; resolution?: string },
  ): Promise<VolumeHistoryBucket[]>
  getProtocolMetrics(): Promise<ProtocolMetrics>
}

const EMPTY_PAGE = <T>(pageSize: number): PaginatedResponse<T> => ({
  data: [],
  total: 0,
  pages: 0,
  currentPage: 1,
  pageSize,
})

/**
 * Localnet has no hosted indexer. Every method returns an empty shape so
 * the discovery UI renders an empty state instead of erroring. Callers
 * that need a pool detail on localnet should go through the chain-direct
 * `getPoolFromChain` path — wired in `dlmm.service.getPool`.
 */
export const localnetDlmmIndex: DlmmIndexProvider = {
  async listPools(opts) {
    return EMPTY_PAGE<PoolSummary>(opts.pageSize ?? 50)
  },
  async getPool() {
    return null
  },
  async listGroups(opts) {
    return EMPTY_PAGE<PoolGroup>(opts.pageSize ?? 50)
  },
  async getGroup(mintPair) {
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
  },
  async getOhlcv() {
    return []
  },
  async getVolumeHistory() {
    return []
  },
  async getProtocolMetrics() {
    return {
      totalTvl: 0,
      volume24h: 0,
      fee24h: 0,
      totalVolume: 0,
      totalFees: 0,
      totalPools: 0,
    }
  },
}
