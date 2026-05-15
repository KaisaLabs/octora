/**
 * Test plan IDs:
 *   MIXER-RPS-001 readPoolStatus null when pool PDA has no account
 *   MIXER-RPS-002 readPoolStatus surfaces nextLeafIndex, anonymitySet, isPaused, balance
 *   MIXER-RPS-003 readPoolStatus marks paused pools when is_paused byte = 1
 *   MIXER-RPS-004 readPoolStatus derives the canonical PDA from programId + denomination
 *   MIXER-ANG-001 empty 0.1 SOL pool → buildWithdrawTransaction → AnonymitySetTooThinError
 *   MIXER-ANG-002 thin-but-nonzero pool below MIN_ANONYMITY_SET still trips the guard
 *   MIXER-ANG-003 pool above MIN_ANONYMITY_SET passes the guard (no throw)
 *
 * Targets the static `MixerService.readPoolStatus` helper used by
 * `/mixer/pools` to enumerate every configured denomination in one
 * request, plus the per-denom Anonymity Set Guard exercised at withdraw
 * build time. The MIXER-ANG tests exist to lock in that the
 * {0.1, 1, 5, 10} SOL Denomination ladder enforces MIN_ANONYMITY_SET
 * independently per pool — i.e. an empty 0.1 SOL pool refuses
 * withdrawals even when the 1 SOL pool is healthy.
 */
import { describe, expect, it } from 'vitest'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import type { Wallet } from '@coral-xyz/anchor'

import { AnonymitySetTooThinError, MIN_ANONYMITY_SET } from '../anonymity.js'
import { MixerService, MixerPoolNotInitializedError } from '../mixer.service.js'
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

/**
 * `MixerService` only calls `chain.rawConnection()` from `hydrateFromChain`
 * and `chain.anchorProvider(wallet)` from the constructor (to build the
 * Anchor `Program` used by the tx-builders). The Anonymity Set Guard path
 * doesn't go through either — but the constructor does — so we subclass
 * `ScriptedChain` here and stub both with no-ops sufficient for the guard
 * tests. We only ever call `getPoolStatus` (uses `getAccountInfo` +
 * `getBalance`, both already on `ScriptedChain`) and the public
 * `assertAnonymitySetSatisfied` / `buildWithdrawTransaction` entrypoints,
 * the latter of which short-circuits on the guard *before* touching the
 * Anchor program — so the stubbed provider is never dereferenced.
 */
class StubAnchorChain extends ScriptedChain {
  override rawConnection() {
    // `MixerService` only uses the raw connection inside `hydrateFromChain`,
    // which these tests never call. Return a dummy object instead of
    // throwing so the `private connection = this.chain.rawConnection()`
    // assignment in the constructor doesn't blow up.
    return {} as never
  }

  override anchorProvider(_wallet: Wallet) {
    // Same rationale as `rawConnection`: the provider is only consumed
    // when an Anchor `Program` method is invoked (deposit/withdraw/init
    // builders). The Anonymity Set Guard runs first and throws, so the
    // provider is never dereferenced in these tests.
    return {} as never
  }
}

const DEFAULT_PROGRAM_ID = new PublicKey('11111111111111111111111111111111')

function makeService(opts: {
  chain: StubAnchorChain
  denomination: bigint
  programId?: PublicKey
}) {
  return new MixerService({
    chain: opts.chain,
    denomination: opts.denomination,
    programId: opts.programId ?? DEFAULT_PROGRAM_ID,
  })
}

describe('MixerService Anonymity Set Guard', () => {
  // 0.1 SOL is the smallest tier in the Denomination ladder; if any pool
  // is going to start empty it'll be this one. Use it as the canonical
  // fixture so the test name maps directly to the ticket's acceptance
  // criterion.
  const DENOM_0_1_SOL = 100_000_000n

  it('MIXER-ANG-001: empty 0.1 SOL pool → buildWithdrawTransaction → AnonymitySetTooThinError', async () => {
    const pda = poolPda(DENOM_0_1_SOL)
    const chain = new StubAnchorChain({
      accounts: {
        [pda.toBase58()]: buildPoolAccount({ nextLeafIndex: 0, isPaused: false }),
      },
      balances: { [pda.toBase58()]: 0 },
    })
    const svc = makeService({ chain, denomination: DENOM_0_1_SOL })

    await expect(
      svc.buildWithdrawTransaction(
        'Dep11111111111111111111111111111111111111111',
        'Rec11111111111111111111111111111111111111111',
        // Proof/public-inputs/nullifier are unused before the guard fires.
        'AAAA',
        'AAAA',
        '1',
      ),
    ).rejects.toBeInstanceOf(AnonymitySetTooThinError)

    // Sanity: the snapshot itself reflects the zero anonymity set so
    // operators reading /mixer/pools see the same number the guard saw.
    const snap = await svc.getAnonymitySetSnapshot()
    expect(snap.nextLeafIndex).toBe(0)
    expect(snap.withdrawalCount).toBe(0)
    expect(snap.anonymitySet).toBe(0)
  })

  it('MIXER-ANG-002: thin-but-nonzero pool (below MIN_ANONYMITY_SET) still trips the guard', async () => {
    // Pick a count that's deliberately under the floor (default 20) but
    // not zero, to catch the off-by-one between `<` and `<=`.
    const thinCount = MIN_ANONYMITY_SET - 1
    const pda = poolPda(DENOM_0_1_SOL)
    const chain = new StubAnchorChain({
      accounts: {
        [pda.toBase58()]: buildPoolAccount({ nextLeafIndex: thinCount, isPaused: false }),
      },
    })
    const svc = makeService({ chain, denomination: DENOM_0_1_SOL })

    await expect(svc.assertAnonymitySetSatisfied()).rejects.toMatchObject({
      code: 'ANONYMITY_SET_TOO_THIN',
      current: thinCount,
      required: MIN_ANONYMITY_SET,
      denomination: DENOM_0_1_SOL,
    })
  })

  it('MIXER-ANG-003: pool at MIN_ANONYMITY_SET passes the guard (no throw)', async () => {
    const pda = poolPda(DENOM_0_1_SOL)
    const chain = new StubAnchorChain({
      accounts: {
        [pda.toBase58()]: buildPoolAccount({
          nextLeafIndex: MIN_ANONYMITY_SET,
          isPaused: false,
        }),
      },
    })
    const svc = makeService({ chain, denomination: DENOM_0_1_SOL })

    await expect(svc.assertAnonymitySetSatisfied()).resolves.toBeUndefined()
  })

  it('MIXER-ANG-001b: withdraw against an *uninitialized* 0.1 SOL pool returns MixerPoolNotInitializedError', async () => {
    // The guard sits behind `assertPoolInitialized`. If the pool PDA
    // doesn't exist at all, the user should get a clearer "init the pool
    // first" error rather than "anonymity set thin". Locks in the
    // ordering so the two error surfaces don't accidentally swap.
    const chain = new StubAnchorChain()
    const svc = makeService({ chain, denomination: DENOM_0_1_SOL })

    await expect(
      svc.buildWithdrawTransaction(
        'Dep11111111111111111111111111111111111111111',
        'Rec11111111111111111111111111111111111111111',
        'AAAA',
        'AAAA',
        '1',
      ),
    ).rejects.toBeInstanceOf(MixerPoolNotInitializedError)
  })
})
