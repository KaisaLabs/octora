const API_BASE = import.meta.env.VITE_API_URL ?? '/api'

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
  createdAt: number
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

import type { Pool } from "@/components/octora/types";

/** Formats a number as a human-readable USD string */
function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** Formats a number as a percentage string */
function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

/** Maps an API PoolSummary to the internal Pool type */
export function mapPoolSummary(summary: PoolSummary): Pool {
  const tokenA = summary.tokenX.symbol;
  const tokenB = summary.tokenY.symbol;

  return {
    id: summary.address,
    name: summary.name || `${tokenA} / ${tokenB}`,
    pair: summary.pair || `${tokenA}-${tokenB}`,
    tokenA,
    tokenB,
    tokenAMint: summary.tokenX.mint,
    tokenBMint: summary.tokenY.mint,
    address: summary.address,
    protocol: "Meteora DLMM",
    tvl: fmtUsd(summary.tvl),
    apr: fmtPct(summary.apr),
    volume24h: fmtUsd(summary.volume24h),
    fees24h: fmtUsd(summary.fees24h),
    strategy: "Auto range · Balanced",
    depth: summary.binStep <= 10 ? "Tight" : summary.binStep <= 50 ? "Medium" : "Wide",
    risk: summary.apr > 30 ? "Active" : "Balanced",
    feeBps: summary.feeBps,
    binStep: summary.binStep,
    createdAt: summary.createdAt ?? 0,
    binRange: summary.binStep ? `±${summary.binStep} bins` : "Dynamic",
    priceRange: "Live pricing",
    activeBinId: 0,
    activePrice: 0,
    allocation: { tokenA: 50, tokenB: 50 },
    tags: summary.binStep <= 10 ? ["Tight bands", "Active"] : ["Wide coverage", "Passive"],
  };
}

export async function listPools(opts: {
  network?: 'mainnet' | 'devnet'
  search?: string
  page?: number
  pageSize?: number
  sortBy?: string
  filterBy?: string
} = {}): Promise<PoolSummary[]> {
  const params = new URLSearchParams()
  if (opts.network) params.set('network', opts.network)
  if (opts.search) params.set('search', opts.search)
  if (opts.page) params.set('page', String(opts.page))
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
  if (opts.sortBy) params.set('sortBy', opts.sortBy)
  if (opts.filterBy) params.set('filterBy', opts.filterBy)

  const res = await fetch(`${API_BASE}/dlmm/pools?${params.toString()}`)
  if (!res.ok) {
    throw new Error(`Failed to fetch pools: ${res.status}`)
  }
  const data = await res.json()
  return data.data
}

export interface PoolBinsResponse {
  address: string
  network: 'mainnet' | 'devnet'
  activeBinId: number
  binStep: number
  bins: Array<{
    binId: number
    price: number
    liquidity: number
    xAmount: string
    yAmount: string
  }>
}

export async function getPoolBins(
  address: string,
  opts: { network?: 'mainnet' | 'devnet'; count?: number } = {}
): Promise<PoolBinsResponse> {
  const params = new URLSearchParams()
  if (opts.network) params.set('network', opts.network)
  if (opts.count) params.set('count', String(opts.count))

  const res = await fetch(`${API_BASE}/dlmm/pools/${address}/bins?${params.toString()}`)
  if (!res.ok) {
    throw new Error(`Failed to fetch bins: ${res.status}`)
  }
  return res.json()
}

export async function getPoolDetail(
  address: string,
  network: 'mainnet' | 'devnet' = 'mainnet'
): Promise<PoolDetail> {
  const params = new URLSearchParams()
  params.set('network', network)

  const res = await fetch(`${API_BASE}/dlmm/pools/${address}?${params.toString()}`)
  if (!res.ok) {
    throw new Error(`Failed to fetch pool: ${res.status}`)
  }
  return res.json()
}
