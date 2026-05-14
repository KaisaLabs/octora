/**
 * DLMM resolution policy — picks the right `DlmmIndexProvider` per
 * network, then dispatches the call.
 *
 * Mainnet uses the hosted Meteora indexer, devnet uses its devnet
 * sibling, localnet has no indexer and falls through to empty data
 * (with one exception: `getPool` reaches into chain-direct
 * `getPoolFromChain` so the browser can navigate to a pool by address
 * on a local validator).
 *
 * Bin reads (`getPoolBins`) and swap quotes (`getSwapQuote`) live in
 * `dlmm.chain.ts` — a *different* operation set (Meteora SDK via RPC),
 * not parallel impls of the index methods. Re-exported here so callers
 * keep importing from one place.
 */
import { mainnetDlmmIndex } from './dlmm.api.mainnet.js'
import { devnetDlmmIndex } from './dlmm.api.devnet.js'
import { localnetDlmmIndex, type DlmmIndexProvider } from './dlmm.provider.js'
import { MeteoraApiError } from './dlmm.api.shared.js'
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
export type { DlmmIndexProvider } from './dlmm.provider.js'
export { MeteoraApiError, getPoolBins, getSwapQuote }
export type { SwapQuoteResult } from './dlmm.chain.js'

/**
 * Return the index provider for a given network. Exported so callers
 * that need to make several calls back-to-back can resolve once instead
 * of paying the dispatch on every method.
 */
export function getDlmmIndex(network: Network): DlmmIndexProvider {
  if (network === 'localnet') return localnetDlmmIndex
  if (network === 'devnet') return devnetDlmmIndex
  return mainnetDlmmIndex
}

export async function listPools(
  network: Network,
  opts: { search?: string; page?: number; pageSize?: number; sortBy?: string; filterBy?: string } = {},
): Promise<PaginatedResponse<PoolSummary>> {
  return getDlmmIndex(network).listPools(opts)
}

export async function getPool(address: string, network: Network): Promise<PoolDetail | null> {
  // Localnet has no hosted index but still needs a pool detail when the
  // browser navigates by address — fall through to the chain-direct
  // reader so the page renders against the local validator.
  if (network === 'localnet') return getPoolFromChain(address, network)
  return getDlmmIndex(network).getPool(address)
}

export async function listGroups(
  network: Network,
  opts: { page?: number; pageSize?: number } = {},
): Promise<PaginatedResponse<PoolGroup>> {
  return getDlmmIndex(network).listGroups(opts)
}

export async function getGroup(
  mintPair: string,
  network: Network,
  opts: { page?: number; pageSize?: number } = {},
): Promise<PoolGroup> {
  return getDlmmIndex(network).getGroup(mintPair, opts)
}

export async function getOhlcv(
  address: string,
  network: Network,
  opts: { startTime?: number; endTime?: number; resolution?: string } = {},
): Promise<OhlcvCandle[]> {
  return getDlmmIndex(network).getOhlcv(address, opts)
}

export async function getVolumeHistory(
  address: string,
  network: Network,
  opts: { startTime?: number; endTime?: number; resolution?: string } = {},
): Promise<VolumeHistoryBucket[]> {
  return getDlmmIndex(network).getVolumeHistory(address, opts)
}

export async function getProtocolMetrics(network: Network): Promise<ProtocolMetrics> {
  return getDlmmIndex(network).getProtocolMetrics()
}
