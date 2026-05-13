/**
 * Shared error class + fetch helper for the per-network Meteora API
 * clients (mainnet / devnet). Both networks expose distinct schemas but
 * share the same auth-less HTTP envelope.
 *
 * Outbound resilience lives here so every network share it:
 *   - One `CircuitBreaker` per process: a sustained burst of 5xx /
 *     network errors trips the breaker and we fast-fail until the
 *     upstream recovers. 404s are explicitly "expected" so missing-pool
 *     lookups never trip it.
 *   - A bounded TTL cache fronts GET requests so a burst of identical
 *     reads (e.g. same pool detail page) hits the upstream once.
 */
import { loadConfig } from '#common/config'
import { UpstreamError } from '#common/errors'
import { CircuitBreaker } from '#common/http/circuit-breaker'
import { TtlCache } from '#common/http/ttl-cache'
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

let breaker: CircuitBreaker | null = null
let cache: TtlCache<string, unknown> | null = null

function getBreaker(): CircuitBreaker {
  if (breaker) return breaker
  const { outboundHttp } = loadConfig()
  breaker = new CircuitBreaker({
    name: 'meteora',
    failureThreshold: outboundHttp.breakerFailureThreshold,
    windowMs: outboundHttp.breakerWindowMs,
    cooldownMs: outboundHttp.breakerCooldownMs,
    // 404s are a normal result (pool doesn't exist on this network); don't
    // let them trip the breaker.
    isExpectedError: (err) => err instanceof MeteoraApiError && err.status === 404,
  })
  return breaker
}

function getCache(): TtlCache<string, unknown> {
  if (cache) return cache
  const { outboundHttp } = loadConfig()
  cache = new TtlCache({
    ttlMs: outboundHttp.meteoraPoolCacheTtlMs,
    max: outboundHttp.meteoraPoolCacheMax,
  })
  return cache
}

/**
 * Test-only escape hatch — resets the breaker/cache so per-test fakes
 * don't leak state across runs. Not exported from the module barrel.
 */
export function __resetMeteoraStateForTests(): void {
  breaker = null
  cache = null
}

function buildUrl(network: 'mainnet' | 'devnet', path: string, params?: URLSearchParams): string {
  const qs = params?.toString()
  return qs ? `${API_BASE[network]}${path}?${qs}` : `${API_BASE[network]}${path}`
}

async function rawFetchMeteora(url: string): Promise<Response> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new MeteoraApiError(res.status, `Meteora API error: ${res.status}`)
  }
  return res
}

/**
 * Fetch a Meteora endpoint through the circuit breaker. Returns the raw
 * `Response` so callers can stream / json() as they see fit. Use
 * {@link fetchMeteoraJson} when the response is JSON and benefits from
 * caching (most callers do).
 */
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
  const url = buildUrl(network, path, params)
  return getBreaker().exec(() => rawFetchMeteora(url))
}

/**
 * Cached JSON fetch: response body is keyed by `network|path|qs` and
 * served from the per-process TTL cache when fresh. Bypass with
 * {@link fetchMeteora} when you need streaming or a non-JSON body.
 *
 * Errors are not cached — a transient failure does not pollute the
 * cache for the duration of the TTL.
 */
export async function fetchMeteoraJson<T>(
  network: Network,
  path: string,
  params?: URLSearchParams,
): Promise<T> {
  if (network === 'localnet') {
    throw new MeteoraApiError(
      501,
      `Meteora indexer not available on localnet (path=${path}); use the chain-direct path`,
    )
  }
  const url = buildUrl(network, path, params)
  const c = getCache()
  const cached = c.get(url) as T | undefined
  if (cached !== undefined) return cached

  const res = await getBreaker().exec(() => rawFetchMeteora(url))
  const body = (await res.json()) as T
  c.set(url, body)
  return body
}
