import type { TokenIcon, TokenIconMap } from './tokens.types'

const JUPITER_SEARCH = 'https://lite-api.jup.ag/tokens/v2/search'

// Jupiter's search endpoint accepts a single `query` value, but practical
// testing shows comma-separated mints return the full set in one response.
// Cap per request to stay below URL length limits.
const JUPITER_MAX_IDS = 50

// Icons rarely change; cache aggressively. 1h is generous and still keeps
// pressure off Jupiter when the pool list reshuffles.
const CACHE_TTL_MS = 60 * 60 * 1000

// Negative cache for unknown mints — Jupiter shouldn't be hit repeatedly for
// mints with no logoURI. Shorter than the positive cache since metadata may
// land later.
const NEGATIVE_TTL_MS = 10 * 60 * 1000

interface CachedEntry {
  icon: TokenIcon
  fetchedAt: number
}

const cache = new Map<string, CachedEntry>()

export class JupiterTokensError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'JupiterTokensError'
  }
}

/** Resolve icon URLs for a list of mints. Always returns one entry per input
 *  mint (even when Jupiter has no record) so callers can stop refetching. */
export async function getTokenIcons(mints: string[]): Promise<TokenIconMap> {
  const now = Date.now()
  const result: TokenIconMap = {}
  const missing: string[] = []

  for (const mint of new Set(mints)) {
    const hit = cache.get(mint)
    if (hit) {
      const ttl = hit.icon.icon ? CACHE_TTL_MS : NEGATIVE_TTL_MS
      if (now - hit.fetchedAt < ttl) {
        result[mint] = hit.icon
        continue
      }
    }
    missing.push(mint)
  }

  if (missing.length === 0) return result

  const fresh = await fetchFromJupiter(missing)
  // Populate found mints, then fill the rest with negative-cache entries so
  // unknown mints aren't refetched on every render.
  for (const mint of missing) {
    const found = fresh[mint] ?? { mint, icon: null, symbol: null }
    cache.set(mint, { icon: found, fetchedAt: now })
    result[mint] = found
  }

  return result
}

async function fetchFromJupiter(mints: string[]): Promise<TokenIconMap> {
  const out: TokenIconMap = {}
  for (let i = 0; i < mints.length; i += JUPITER_MAX_IDS) {
    const chunk = mints.slice(i, i + JUPITER_MAX_IDS)
    const url = `${JUPITER_SEARCH}?query=${chunk.join(',')}`
    const res = await fetch(url)
    if (!res.ok) {
      throw new JupiterTokensError(res.status, `Jupiter tokens API ${res.status}`)
    }
    const body = (await res.json()) as Array<{ id?: string; icon?: string; symbol?: string }>
    if (!Array.isArray(body)) continue
    for (const row of body) {
      if (typeof row?.id !== 'string') continue
      out[row.id] = {
        mint: row.id,
        icon: typeof row.icon === 'string' && row.icon.length > 0 ? row.icon : null,
        symbol: typeof row.symbol === 'string' ? row.symbol : null,
      }
    }
  }
  return out
}
