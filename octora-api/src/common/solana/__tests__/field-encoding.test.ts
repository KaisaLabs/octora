/**
 * Test plan IDs:
 *   FE-001 bigintToBytes32 encodes small values as 32 bytes big-endian
 *   FE-002 bigintToBytes32 encodes 2^256 - 1 as all-FF
 *   FE-003 bigintToBytes32 encodes zero as all-zero
 *   FE-004 bigintToBytes32 throws SeedRangeError on 2^256 (one past max)
 *   FE-005 bigintToBytes32 throws SeedRangeError on negative values
 *   FE-006 SeedRangeError carries `field` + `value` in details for 422 response
 */
import { describe, expect, it } from 'vitest'

import {
  bigintToBytes32,
  SeedRangeError,
} from '../field-encoding.js'

describe('bigintToBytes32', () => {
  it('FE-001: encodes 0x42 as a 32-byte buffer with 0x42 in the last slot', () => {
    const buf = bigintToBytes32(0x42n, 'commitment')
    expect(buf.length).toBe(32)
    expect(buf[31]).toBe(0x42)
    // every other byte should be zero
    expect(buf.subarray(0, 31).every((b) => b === 0)).toBe(true)
  })

  it('FE-002: encodes 2^256 - 1 as all-FF', () => {
    const max = (1n << 256n) - 1n
    const buf = bigintToBytes32(max, 'commitment')
    expect(buf.length).toBe(32)
    expect(buf.every((b) => b === 0xff)).toBe(true)
  })

  it('FE-003: encodes zero as all-zero', () => {
    const buf = bigintToBytes32(0n, 'nullifierHash')
    expect(buf.length).toBe(32)
    expect(buf.every((b) => b === 0)).toBe(true)
  })

  it('FE-004: throws SeedRangeError on 2^256 (one past max)', () => {
    expect(() => bigintToBytes32(1n << 256n, 'commitment')).toThrow(SeedRangeError)
  })

  it('FE-005: throws SeedRangeError on negative values', () => {
    expect(() => bigintToBytes32(-1n, 'commitment')).toThrow(SeedRangeError)
  })

  it('FE-006: SeedRangeError carries field + value in details for 422 response', () => {
    try {
      bigintToBytes32(1n << 256n, 'nullifierHash')
      throw new Error('expected SeedRangeError')
    } catch (err) {
      expect(err).toBeInstanceOf(SeedRangeError)
      const e = err as SeedRangeError
      expect(e.field).toBe('nullifierHash')
      expect(e.value).toBe(1n << 256n)
    }
  })
})
