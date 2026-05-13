/**
 * Test plan IDs:
 *   OPS-CACHE-001 hit before TTL, miss after
 *   OPS-CACHE-002 eviction respects `max` (FIFO)
 *   OPS-CACHE-003 set on existing key refreshes position + expiry
 */
import { describe, expect, it } from 'vitest'

import { TtlCache } from '../ttl-cache.js'

function makeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('TtlCache', () => {
  it('OPS-CACHE-001: returns the value before TTL and undefined after', () => {
    const clock = makeClock()
    const c = new TtlCache<string, number>({ ttlMs: 100, max: 10, now: clock.now })
    c.set('a', 1)
    expect(c.get('a')).toBe(1)
    clock.advance(99)
    expect(c.get('a')).toBe(1)
    clock.advance(2)
    expect(c.get('a')).toBeUndefined()
  })

  it('OPS-CACHE-002: evicts oldest entry when `max` is exceeded', () => {
    const c = new TtlCache<string, number>({ ttlMs: 10_000, max: 2 })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBe(2)
    expect(c.get('c')).toBe(3)
    expect(c.size).toBe(2)
  })

  it('OPS-CACHE-003: re-set refreshes TTL on the existing key', () => {
    const clock = makeClock()
    const c = new TtlCache<string, number>({ ttlMs: 100, max: 4, now: clock.now })
    c.set('a', 1)
    clock.advance(50)
    c.set('a', 2)
    clock.advance(60)
    // Second set restarted the TTL; entry is still alive even though
    // 110ms have elapsed since the first insert.
    expect(c.get('a')).toBe(2)
    clock.advance(50)
    expect(c.get('a')).toBeUndefined()
  })
})
