/**
 * Test plan IDs:
 *   OPS-HEALTH-001 checkRpc ok when chain returns a positive slot
 *   OPS-HEALTH-002 checkRpc degraded when chain throws
 *   OPS-HEALTH-003 checkRpc degraded when slot is 0
 *   OPS-HEALTH-004 checkMixer ok when MixerPool exists and is_paused=0
 *   OPS-HEALTH-005 checkMixer degraded when pool account is missing
 *   OPS-HEALTH-006 checkMixer degraded when is_paused=1
 *
 * Coverage gap before this file: 100%. health.ts was untested even
 * though /health gates orchestrator routing.
 */
import { describe, expect, it } from 'vitest'
import { PublicKey, SystemProgram } from '@solana/web3.js'

import { checkMixer, checkRpc } from '../health.js'
import { ScriptedChain } from '../solana/scripted-chain.js'
import {
  MIXER_POOL_IS_PAUSED_OFFSET,
  MIXER_POOL_NEXT_LEAF_INDEX_OFFSET,
} from '../../modules/mixer/layout.js'
import { type SolanaChain, UnsupportedChainOperationError } from '../solana/chain.js'
import type { AppConfig } from '../config/index.js'

const PROGRAM_ID = new PublicKey('11111111111111111111111111111111')
const DENOMINATION = 1_000_000_000n
const MIXER_POOL_SEED = Buffer.from('mixer_pool')

function poolPda(): PublicKey {
  const denomBytes = Buffer.alloc(8)
  denomBytes.writeBigUInt64LE(DENOMINATION)
  const [pda] = PublicKey.findProgramAddressSync([MIXER_POOL_SEED, denomBytes], PROGRAM_ID)
  return pda
}

function buildMixerPoolAccount(opts: { nextLeafIndex: number; isPaused: boolean }) {
  const size = MIXER_POOL_IS_PAUSED_OFFSET + 1
  const data = Buffer.alloc(size)
  data.writeUInt32LE(opts.nextLeafIndex, MIXER_POOL_NEXT_LEAF_INDEX_OFFSET)
  data[MIXER_POOL_IS_PAUSED_OFFSET] = opts.isPaused ? 1 : 0
  return {
    executable: false,
    owner: SystemProgram.programId,
    lamports: 0,
    data,
    rentEpoch: 0,
  }
}

const baseConfig: AppConfig = {
  mixerProgramId: PROGRAM_ID.toBase58(),
  mixerDenomination: DENOMINATION,
} as unknown as AppConfig

describe('checkRpc', () => {
  it('OPS-HEALTH-001: ok when chain returns a positive slot', async () => {
    const chain = new ScriptedChain({ slot: 12_345 })
    const result = await checkRpc(chain)
    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('OPS-HEALTH-002: degraded when chain throws', async () => {
    // Build an ad-hoc chain whose getSlot rejects; reuse ScriptedChain
    // for everything else so we only override the one method.
    const chain: SolanaChain = Object.assign(new ScriptedChain(), {
      getSlot: async () => {
        throw new Error('node behind')
      },
    })
    const result = await checkRpc(chain)
    expect(result.ok).toBe(false)
    expect(result.detail).toBe('node behind')
  })

  it('OPS-HEALTH-003: degraded when slot is 0', async () => {
    const chain = new ScriptedChain({ slot: 0 })
    const result = await checkRpc(chain)
    expect(result.ok).toBe(false)
  })
})

describe('checkMixer', () => {
  it('OPS-HEALTH-004: ok when MixerPool exists and is_paused=0', async () => {
    const chain = new ScriptedChain({
      accounts: {
        [poolPda().toBase58()]: buildMixerPoolAccount({ nextLeafIndex: 5, isPaused: false }),
      },
    })
    const result = await checkMixer(chain, baseConfig)
    expect(result.ok).toBe(true)
  })

  it('OPS-HEALTH-005: degraded when pool account is missing', async () => {
    const chain = new ScriptedChain()
    const result = await checkMixer(chain, baseConfig)
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/not found — pool not initialized/)
  })

  it('OPS-HEALTH-006: degraded when is_paused=1', async () => {
    const chain = new ScriptedChain({
      accounts: {
        [poolPda().toBase58()]: buildMixerPoolAccount({ nextLeafIndex: 5, isPaused: true }),
      },
    })
    const result = await checkMixer(chain, baseConfig)
    expect(result.ok).toBe(false)
    expect(result.detail).toBe('MixerPool.is_paused = true')
  })
})

describe('ScriptedChain hard-stops', () => {
  it('throws on rawConnection so tests cannot fall through to real RPC', () => {
    const chain = new ScriptedChain()
    expect(() => chain.rawConnection()).toThrow(UnsupportedChainOperationError)
  })
})
