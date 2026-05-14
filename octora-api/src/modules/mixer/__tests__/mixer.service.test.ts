/**
 * Test plan IDs:
 *   MIXER-RPS-001 readPoolStatus null when pool PDA has no account
 *   MIXER-RPS-002 readPoolStatus surfaces nextLeafIndex, anonymitySet, isPaused, balance
 *   MIXER-RPS-003 readPoolStatus marks paused pools when is_paused byte = 1
 *   MIXER-RPS-004 readPoolStatus derives the canonical PDA from programId + denomination
 *
 * Targets the static `MixerService.readPoolStatus` helper used by
 * `/mixer/pools` to enumerate every configured denomination in one
 * request. Untested before step 3 — previously buried behind a
 * per-request `new Connection(rpcUrl, "confirmed")` in the controller.
 */
import { describe, expect, it } from 'vitest'
import { PublicKey, SystemProgram } from '@solana/web3.js'

import { MixerService } from '../mixer.service.js'
import { ScriptedChain } from '#common/solana/scripted-chain'
import {
  MIXER_POOL_IS_PAUSED_OFFSET,
  MIXER_POOL_NEXT_LEAF_INDEX_OFFSET,
} from '../layout.js'

const PROGRAM_ID = new PublicKey('11111111111111111111111111111111')
const DENOMINATION = 1_000_000_000n
const MIXER_POOL_SEED = Buffer.from('mixer_pool')

function poolPda(denomination = DENOMINATION): PublicKey {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(denomination)
  const [pda] = PublicKey.findProgramAddressSync([MIXER_POOL_SEED, buf], PROGRAM_ID)
  return pda
}

function buildPoolAccount(opts: { nextLeafIndex: number; isPaused: boolean }) {
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

describe('MixerService.readPoolStatus', () => {
  it('MIXER-RPS-001: returns null when the pool PDA has no on-chain account', async () => {
    const chain = new ScriptedChain()
    const result = await MixerService.readPoolStatus(chain, PROGRAM_ID, DENOMINATION)
    expect(result).toBeNull()
  })

  it('MIXER-RPS-002: surfaces nextLeafIndex, anonymitySet, isPaused, balance', async () => {
    const pda = poolPda()
    const chain = new ScriptedChain({
      accounts: {
        [pda.toBase58()]: buildPoolAccount({ nextLeafIndex: 8, isPaused: false }),
      },
      balances: { [pda.toBase58()]: 5_000_000_000 },
    })

    const result = await MixerService.readPoolStatus(chain, PROGRAM_ID, DENOMINATION)

    expect(result).toEqual({
      poolAddress: pda.toBase58(),
      denomination: DENOMINATION.toString(),
      nextLeafIndex: 8,
      depositCount: 8,
      // anonymitySet lower-bound = depositCount until nullifier scan lands
      withdrawalCount: 0,
      anonymitySet: 8,
      isPaused: false,
      balance: '5000000000',
    })
  })

  it('MIXER-RPS-003: marks paused pools when is_paused = 1', async () => {
    const pda = poolPda()
    const chain = new ScriptedChain({
      accounts: {
        [pda.toBase58()]: buildPoolAccount({ nextLeafIndex: 0, isPaused: true }),
      },
    })

    const result = await MixerService.readPoolStatus(chain, PROGRAM_ID, DENOMINATION)
    expect(result?.isPaused).toBe(true)
  })

  it('MIXER-RPS-004: derives the canonical PDA from programId + denomination', async () => {
    const otherDenom = 5_000_000_000n
    const expectedPda = poolPda(otherDenom)
    const chain = new ScriptedChain({
      accounts: {
        [expectedPda.toBase58()]: buildPoolAccount({ nextLeafIndex: 2, isPaused: false }),
      },
    })

    await MixerService.readPoolStatus(chain, PROGRAM_ID, otherDenom)

    const reads = chain.calls.filter((c) => c.method === 'getAccountInfo')
    expect(reads).toHaveLength(1)
    expect(reads[0]?.args[0]).toBe(expectedPda.toBase58())
  })
})
