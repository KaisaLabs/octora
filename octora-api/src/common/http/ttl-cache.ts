/**
 * Bounded TTL cache. Used for short-lived response caching in front of
 * outbound HTTP (Meteora pool details, etc.) so the cache survives a
 * thundering herd but never leaks unbounded keys.
 *
 * Eviction order is insertion (FIFO once `max` is reached) — adequate
 * for our access patterns where every entry is short-lived. Drop in
 * `lru-cache` if we ever need recency-aware eviction; the call sites
 * only depend on `get` / `set`.
 *
 * Not thread-safe (Node is single-threaded per process). Concurrency
 * across requests is fine; the worst case is two parallel fetches
 * racing to populate the same key — both succeed, last write wins.
 */
export interface TtlCacheOptions {
  /** Time-to-live in ms applied to every entry. */
  ttlMs: number
  /** Hard cap on entry count. Oldest entry is evicted first when full. */
  max: number
  /** Optional clock injection for tests. */
  now?: () => number
}

interface Entry<V> {
  value: V
  expiresAt: number
}

export class TtlCache<K, V> {
  private readonly ttlMs: number
  private readonly max: number
  private readonly now: () => number
  private readonly store = new Map<K, Entry<V>>()

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs
    this.max = options.max
    this.now = options.now ?? Date.now
  }

  get(key: K): V | undefined {
    const hit = this.store.get(key)
    if (!hit) return undefined
    if (this.now() >= hit.expiresAt) {
      this.store.delete(key)
      return undefined
    }
    return hit.value
  }

  set(key: K, value: V): void {
    if (this.store.has(key)) {
      this.store.delete(key)
    } else if (this.store.size >= this.max) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs })
  }

  delete(key: K): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }

  get size(): number {
    return this.store.size
  }
}
