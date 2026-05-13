/**
 * Shared error class + fetch helper for the per-network Meteora API
 * clients (mainnet / devnet). Both networks expose distinct schemas but
 * share the same auth-less HTTP envelope.
 */
import { UpstreamError } from '#common/errors'
import type { Network } from './dlmm.types.js'

const API_BASE = {
  mainnet: 'https://dlmm.datapi.meteora.ag',
  devnet: 'https://dlmm-api.devnet.meteora.ag',
} as const

export class MeteoraApiError extends UpstreamError {
  constructor(public status: number, message: string) {
    super(message, { code: 'meteora_upstream_error', details: { upstreamStatus: status } })
    this.name = 'MeteoraApiError'
  }
}

export async function fetchMeteora(
  network: Network,
  path: string,
  params?: URLSearchParams,
): Promise<Response> {
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
