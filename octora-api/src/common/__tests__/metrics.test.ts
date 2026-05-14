/**
 * Test plan IDs:
 *   OPS-METRICS-001 collectMixer returns null when the pool PDA has no account
 *   OPS-METRICS-002 collectMixer parses nextLeafIndex + isPaused + balance from the live layout
 *   OPS-METRICS-003 collectMixer surfaces is_paused=true when the on-chain pause byte is set
 *   OPS-METRICS-004 collectMixer reads the chain at the expected PDA (computed from programId + denomination)
 */
import { describe, expect, it } from 'vitest'
import { PublicKey, SystemProgram } from '@solana/web3.js'

import { collectMixer } from '../metrics.js'
import { ScriptedChain } from '../solana/scripted-chain.js'
import {
  MIXER_POOL_IS_PAUSED_OFFSET,
  MIXER_POOL_NEXT_LEAF_INDEX_OFFSET,
} from '../../modules/mixer/layout.js'
import type { AppConfig } from '../config/index.js'

const PROGRAM_ID = new PublicKey('11111111111111111111111111111111')
const DENOMINATION = 1_000_000_000n

const MIXER_POOL_SEED = Buffer.from('mixer_pool')

function poolPda(programId: PublicKey, denomination: bigint): PublicKey {
  const denomBytes = Buffer.alloc(8)
  denomBytes.writeBigUInt64LE(denomination)
  const [pda] = PublicKey.findProgramAddressSync([MIXER_POOL_SEED, denomBytes], programId)
  return pda
}

function buildMixerPoolAccount(opts: { nextLeafIndex: number; isPaused: boolean }) {
  // Buffer must extend through MIXER_POOL_IS_PAUSED_OFFSET to host the pause byte.
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

// Minimal AppConfig stub — collectMixer only reads two fields.
const baseConfig: AppConfig = {
  mixerProgramId: PROGRAM_ID.toBase58(),
  mixerDenomination: DENOMINATION,
} as unknown as AppConfig

describe('collectMixer', () => {
  it('OPS-METRICS-001: returns null when the pool PDA has no on-chain account', async () => {
    const chain = new ScriptedChain() // empty — every getAccountInfo returns null
    const result = await collectMixer(chain, baseConfig)
    expect(result).toBeNull()
  })

  it('OPS-METRICS-002: parses nextLeafIndex + balance from the live layout', async () => {
    const pda = poolPda(PROGRAM_ID, DENOMINATION)
    const chain = new ScriptedChain({
      accounts: {
        [pda.toBase58()]: buildMixerPoolAccount({ nextLeafIndex: 17, isPaused: false }),
      },
      balances: { [pda.toBase58()]: 42_000_000_000 },
    })

    const result = await collectMixer(chain, baseConfig)

    expect(result).toEqual({
      poolAddress: pda.toBase58(),
      balanceLamports: '42000000000',
      nextLeafIndex: 17,
      isPaused: false,
    })
  })

  it('OPS-METRICS-003: surfaces isPaused=true when the pause byte is set', async () => {
    const pda = poolPda(PROGRAM_ID, DENOMINATION)
    const chain = new ScriptedChain({
      accounts: {
        [pda.toBase58()]: buildMixerPoolAccount({ nextLeafIndex: 0, isPaused: true }),
      },
    })

    const result = await collectMixer(chain, baseConfig)

    expect(result?.isPaused).toBe(true)
    expect(result?.nextLeafIndex).toBe(0)
    expect(result?.balanceLamports).toBe('0')
  })

  it('OPS-METRICS-004: reads the expected PDA derived from programId + denomination', async () => {
    const pda = poolPda(PROGRAM_ID, DENOMINATION)
    const chain = new ScriptedChain({
      accounts: {
        [pda.toBase58()]: buildMixerPoolAccount({ nextLeafIndex: 3, isPaused: false }),
      },
    })

    await collectMixer(chain, baseConfig)

    const accountReads = chain.calls.filter((c) => c.method === 'getAccountInfo')
    expect(accountReads).toHaveLength(1)
    expect(accountReads[0]?.args[0]).toBe(pda.toBase58())
  })
})
