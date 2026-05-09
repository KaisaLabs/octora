import type { PriceInfo, PriceMap } from './prices.types'

const JUPITER_PRICE_V3 = 'https://lite-api.jup.ag/price/v3'

// Jupiter accepts up to 100 ids per call. We batch transparently.
const JUPITER_MAX_IDS = 100

// 5s TTL keeps Jupiter load proportional to unique-mint pressure rather than
// per-client polling. UI polls at the same cadence so cache hit rate is high.
const CACHE_TTL_MS = 5_000

interface CachedEntry {
  info: PriceInfo
  fetchedAt: number
}

const cache = new Map<string, CachedEntry>()

export class JupiterPriceError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'JupiterPriceError'
  }
}

/**
 * Returns USD prices for the given mints, using a per-mint TTL cache. Unknown
 * mints (no Jupiter route) are simply omitted from the result.
 */
export async function getPrices(mints: string[]): Promise<PriceMap> {
  const now = Date.now()
  const result: PriceMap = {}
  const missing: string[] = []

  for (const mint of new Set(mints)) {
    const hit = cache.get(mint)
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) {
      result[mint] = hit.info
    } else {
      missing.push(mint)
    }
  }

  if (missing.length === 0) return result

  const fresh = await fetchFromJupiter(missing)
  for (const [mint, info] of Object.entries(fresh)) {
    cache.set(mint, { info, fetchedAt: now })
    result[mint] = info
  }

  return result
}

async function fetchFromJupiter(mints: string[]): Promise<PriceMap> {
  const out: PriceMap = {}
  for (let i = 0; i < mints.length; i += JUPITER_MAX_IDS) {
    const chunk = mints.slice(i, i + JUPITER_MAX_IDS)
    const url = `${JUPITER_PRICE_V3}?ids=${chunk.join(',')}`
    const res = await fetch(url)
    if (!res.ok) {
      throw new JupiterPriceError(res.status, `Jupiter price API ${res.status}`)
    }
    const body = (await res.json()) as Record<string, Partial<PriceInfo> | null>
    for (const [mint, raw] of Object.entries(body)) {
      if (!raw || typeof raw.usdPrice !== 'number') continue
      out[mint] = {
        usdPrice: raw.usdPrice,
        priceChange24h: typeof raw.priceChange24h === 'number' ? raw.priceChange24h : 0,
        decimals: typeof raw.decimals === 'number' ? raw.decimals : 0,
        blockId: typeof raw.blockId === 'number' ? raw.blockId : 0,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      }
    }
  }
  return out
}
