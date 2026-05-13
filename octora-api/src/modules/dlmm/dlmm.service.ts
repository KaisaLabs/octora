/**
 * DLMM resolution policy — picks the right source per (network, endpoint).
 *
 * Mainnet uses `dlmm.api.mainnet.ts`. Devnet uses `dlmm.api.devnet.ts`.
 * Localnet has no indexer; `getPool` falls through to the chain-direct
 * path in `dlmm.chain.ts`. Bin reads (`getPoolBins`) and swap quotes
 * (`getSwapQuote`) are always chain-direct — they're cheap enough on
 * RPC and don't need the indexer's denormalised shape.
 */
import { MeteoraApiError } from './dlmm.api.shared.js'
import {
  listPoolsMainnet,
  getPoolMainnet,
  listGroupsMainnet,
  getGroupMainnet,
  getOhlcvMainnet,
  getVolumeHistoryMainnet,
  getProtocolMetricsMainnet,
} from './dlmm.api.mainnet.js'
import {
  listPoolsDevnet,
  getPoolDevnet,
  listGroupsDevnet,
  getGroupDevnet,
  getVolumeHistoryDevnet,
  getProtocolMetricsDevnet,
} from './dlmm.api.devnet.js'
import { getPoolBins, getPoolFromChain, getSwapQuote } from './dlmm.chain.js'
import type {
  Network,
  PoolSummary,
  PoolDetail,
  PoolGroup,
  OhlcvCandle,
  VolumeHistoryBucket,
  ProtocolMetrics,
  PaginatedResponse,
} from './dlmm.types.js'

export type { Network } from './dlmm.types.js'
export { MeteoraApiError, getPoolBins, getSwapQuote }
export type { SwapQuoteResult } from './dlmm.chain.js'

export async function listPools(
  network: Network,
  opts: { search?: string; page?: number; pageSize?: number; sortBy?: string; filterBy?: string } = {},
): Promise<PaginatedResponse<PoolSummary>> {
  if (network === 'localnet') {
    // No hosted indexer for localnet — the browser navigates by pool address
    // directly. Return empty so the listing UI renders without errors.
    return { data: [], total: 0, pages: 0, currentPage: 1, pageSize: opts.pageSize ?? 50 }
  }
  if (network === 'devnet') return listPoolsDevnet(opts)
  return listPoolsMainnet(opts)
}

export async function getPool(address: string, network: Network): Promise<PoolDetail | null> {
  if (network === 'localnet') return getPoolFromChain(address, network)
  if (network === 'devnet') return getPoolDevnet(address)
  return getPoolMainnet(address)
}

export async function listGroups(
  network: Network,
  opts: { page?: number; pageSize?: number } = {},
): Promise<PaginatedResponse<PoolGroup>> {
  if (network === 'localnet') {
    return { data: [], total: 0, pages: 0, currentPage: 1, pageSize: opts.pageSize ?? 50 }
  }
  if (network === 'devnet') return listGroupsDevnet(opts)
  return listGroupsMainnet(opts)
}

export async function getGroup(
  mintPair: string,
  network: Network,
  opts: { page?: number; pageSize?: number } = {},
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
  return getGroupMainnet(mintPair, opts)
}

export async function getOhlcv(
  address: string,
  network: Network,
  opts: { startTime?: number; endTime?: number; resolution?: string } = {},
): Promise<OhlcvCandle[]> {
  // Devnet/localnet have no OHLCV endpoint. Return empty rather than 404
  // so the UI can render its empty/fallback state.
  if (network === 'devnet' || network === 'localnet') return []
  return getOhlcvMainnet(address, opts)
}

export async function getVolumeHistory(
  address: string,
  network: Network,
  opts: { startTime?: number; endTime?: number; resolution?: string } = {},
): Promise<VolumeHistoryBucket[]> {
  if (network === 'localnet') return []
  if (network === 'devnet') return getVolumeHistoryDevnet(address, opts)
  return getVolumeHistoryMainnet(address, opts)
}

export async function getProtocolMetrics(network: Network): Promise<ProtocolMetrics> {
  if (network === 'localnet') {
    return { totalTvl: 0, volume24h: 0, fee24h: 0, totalVolume: 0, totalFees: 0, totalPools: 0 }
  }
  if (network === 'devnet') return getProtocolMetricsDevnet()
  return getProtocolMetricsMainnet()
}
