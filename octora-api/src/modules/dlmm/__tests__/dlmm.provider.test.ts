/**
 * Test plan IDs:
 *   DLMM-PROV-001 getDlmmIndex(localnet) returns the empty-stub provider
 *   DLMM-PROV-002 getDlmmIndex(mainnet) returns the hosted mainnet provider
 *   DLMM-PROV-003 getDlmmIndex(devnet) returns the hosted devnet provider
 *   DLMM-PROV-004 localnet stub returns empty results for every method
 *   DLMM-PROV-005 devnet stub overrides getOhlcv to return [] regardless of input
 *
 * The whole point of the DlmmIndexProvider interface is that adding a
 * method forces every adapter to implement it. The TypeScript compiler
 * enforces structural conformance — these tests document the
 * runtime-visible behavioural contract (empty shapes for stubs, value
 * shapes for real providers).
 */
import { describe, expect, it } from 'vitest'

import {
  getDlmmIndex,
  type DlmmIndexProvider,
} from '../dlmm.service.js'
import { localnetDlmmIndex } from '../dlmm.provider.js'
import { mainnetDlmmIndex } from '../dlmm.api.mainnet.js'
import { devnetDlmmIndex } from '../dlmm.api.devnet.js'

describe('getDlmmIndex', () => {
  it('DLMM-PROV-001: localnet routes to the empty-stub provider', () => {
    expect(getDlmmIndex('localnet')).toBe(localnetDlmmIndex)
  })

  it('DLMM-PROV-002: mainnet routes to the hosted mainnet provider', () => {
    expect(getDlmmIndex('mainnet')).toBe(mainnetDlmmIndex)
  })

  it('DLMM-PROV-003: devnet routes to the hosted devnet provider', () => {
    expect(getDlmmIndex('devnet')).toBe(devnetDlmmIndex)
  })
})

describe('localnetDlmmIndex', () => {
  const idx: DlmmIndexProvider = localnetDlmmIndex

  it('DLMM-PROV-004: listPools returns an empty page', async () => {
    const page = await idx.listPools({ pageSize: 25 })
    expect(page).toEqual({
      data: [],
      total: 0,
      pages: 0,
      currentPage: 1,
      pageSize: 25,
    })
  })

  it('DLMM-PROV-004: getPool returns null', async () => {
    expect(await idx.getPool('any-address')).toBeNull()
  })

  it('DLMM-PROV-004: getOhlcv returns empty array', async () => {
    expect(await idx.getOhlcv('any', {})).toEqual([])
  })

  it('DLMM-PROV-004: getProtocolMetrics returns zeroed totals', async () => {
    const m = await idx.getProtocolMetrics()
    expect(m).toEqual({
      totalTvl: 0,
      volume24h: 0,
      fee24h: 0,
      totalVolume: 0,
      totalFees: 0,
      totalPools: 0,
    })
  })
})

describe('devnetDlmmIndex', () => {
  it('DLMM-PROV-005: getOhlcv always returns [] (devnet indexer has no OHLCV)', async () => {
    const ohlcv = await devnetDlmmIndex.getOhlcv('any-pool', { resolution: '1d' })
    expect(ohlcv).toEqual([])
  })
})
