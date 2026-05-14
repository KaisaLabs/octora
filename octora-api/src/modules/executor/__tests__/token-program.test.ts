/**
 * Test plan IDs:
 *   EXEC-TP-001 resolveMintProgram returns plain SPL Token info when mint owner = TOKEN_PROGRAM_ID
 *   EXEC-TP-002 resolveMintProgram throws when the mint account is missing
 *   EXEC-TP-003 resolveMintProgram throws on a foreign program owner (neither SPL Token nor Token-2022)
 *
 * Step 4 of the SolanaChain rollout. resolveMintProgram now takes a
 * SolanaChain instead of a raw Connection. Coverage was 0% before this
 * file — token-program.ts was previously only exercised via in-process
 * tx-building paths that need a real RPC.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'

import {
  _clearMintProgramCacheForTests,
  resolveMintProgram,
} from '../builders/token-program.js'
import { ScriptedChain } from '#common/solana/scripted-chain'

function buildSplMintAccount(decimals: number, owner: PublicKey) {
  // SPL Token Mint layout = 82 bytes; decimals lives at byte 44 (u8).
  const data = Buffer.alloc(82)
  data[44] = decimals
  return { executable: false, owner, lamports: 0, data, rentEpoch: 0 }
}

describe('resolveMintProgram', () => {
  beforeEach(() => {
    _clearMintProgramCacheForTests()
  })

  it('EXEC-TP-001: returns plain SPL Token info when owner = TOKEN_PROGRAM_ID', async () => {
    const mint = new PublicKey('So11111111111111111111111111111111111111112')
    const chain = new ScriptedChain({
      accounts: { [mint.toBase58()]: buildSplMintAccount(9, TOKEN_PROGRAM_ID) },
    })

    const info = await resolveMintProgram(chain, mint)

    expect(info).toEqual({
      programId: TOKEN_PROGRAM_ID,
      isToken2022: false,
      hasTransferHook: false,
      hookProgramId: null,
      unsupported: null,
    })
  })

  it('EXEC-TP-002: throws when the mint account is missing', async () => {
    const mint = new PublicKey('So11111111111111111111111111111111111111112')
    const chain = new ScriptedChain()

    await expect(resolveMintProgram(chain, mint)).rejects.toThrow(
      /Mint account not found/,
    )
  })

  it('EXEC-TP-003: throws on foreign program owner', async () => {
    const mint = new PublicKey('So11111111111111111111111111111111111111112')
    const chain = new ScriptedChain({
      accounts: {
        [mint.toBase58()]: buildSplMintAccount(0, SystemProgram.programId),
      },
    })

    await expect(resolveMintProgram(chain, mint)).rejects.toThrow(
      /neither SPL Token nor Token-2022/,
    )
  })
})
