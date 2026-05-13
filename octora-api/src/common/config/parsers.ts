/**
 * Tiny env-string parsers. Each one is intentionally narrow — no
 * defaulting, no zod-style schema features. Put policy (defaults,
 * required-ness, env-var → field mapping) in `./index.ts`; keep this
 * file mechanical so a typo can't sneak past a unit test.
 *
 * Empty / undefined input always returns `undefined` so the caller can
 * apply its own default with full context. Throwing on malformed input
 * is preferred over silent coercion — a typo in `MIXER_DENOMINATIONS`
 * landing as the default would be invisible.
 */

export function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  if (v === '') return undefined
  if (v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'false' || v === '0' || v === 'no') return false
  throw new Error(`expected boolean (true/false), got ${JSON.stringify(raw)}`)
}

export function parseInteger(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) {
    throw new Error(`expected integer, got ${JSON.stringify(raw)}`)
  }
  return n
}

export function parseFloat(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new Error(`expected number, got ${JSON.stringify(raw)}`)
  }
  return n
}

export function parseBigInt(raw: string | undefined): bigint | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  try {
    return BigInt(raw.trim())
  } catch {
    throw new Error(`expected integer (bigint), got ${JSON.stringify(raw)}`)
  }
}

/**
 * Split a comma-separated string into a deduplicated, trimmed list.
 * Empty entries are dropped. Returns `undefined` on missing/empty input
 * so callers can distinguish "unset" from "empty list".
 */
export function parseCsv(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (items.length === 0) return undefined
  // Dedupe preserving order.
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

/**
 * Parse a comma-separated bigint list. Each entry must be a positive
 * integer literal. Result is sorted ascending and deduplicated so
 * downstream consumers get a stable order regardless of env input.
 *
 * Throws on any malformed entry — silent coercion would let a typo
 * collapse a multi-denom config to a single-denom one without warning.
 */
export function parseBigIntList(
  raw: string | undefined,
  options: { fieldName: string; positive?: boolean } = { fieldName: 'value', positive: true },
): bigint[] | undefined {
  if (raw === undefined) return undefined
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (items.length === 0) return undefined
  const parsed = items.map((s) => {
    let v: bigint
    try {
      v = BigInt(s)
    } catch {
      throw new Error(`${options.fieldName} contains a non-integer entry: ${JSON.stringify(s)}`)
    }
    if (options.positive !== false && v <= 0n) {
      throw new Error(`${options.fieldName} entries must be > 0; got ${v.toString()}`)
    }
    return v
  })
  const seen = new Set<string>()
  const unique = parsed.filter((d) => {
    const k = d.toString()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return unique
}
