/**
 * Test plan IDs:
 *   MINT-SUPPORT-001 plain SPL Token mint -> accept (no throw)
 *   MINT-SUPPORT-002 plain Token-2022 mint, no extensions -> accept
 *   MINT-SUPPORT-003 Token-2022 + TransferHook (non-zero program) -> reject
 *   MINT-SUPPORT-004 Token-2022 + NonTransferable -> reject (different blocked ext)
 *   MINT-SUPPORT-005 Token-2022 + PermanentDelegate -> reject
 *   MINT-SUPPORT-006 Token-2022 + ConfidentialTransferMint -> reject
 *   MINT-SUPPORT-007 Token-2022 + TransferHook with the zero-pubkey sentinel -> accept
 *   MINT-SUPPORT-008 helper performs exactly one RPC read per call (no extra layer)
 *   MINT-SUPPORT-009 reject path surfaces structured ValidationError shape
 *
 * Coverage gate: `assertExecutorSupportsMint` is the gate that prevents a
 * Private Position Close from sliding into `SWAP_FAILED` recovery when the
 * pool's non-SOL side carries an Executor-blocked Token-2022 extension.
 * Every blocked variant the underlying `resolveMintProgram` knows about
 * gets its own case so a future addition to the blocked set without a
 * matching test will fail loudly.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ExtensionType } from '@solana/spl-token'

import { ScriptedChain } from '#common/solana/scripted-chain'
import {
  assertExecutorSupportsMint,
  UnsupportedMintExtensionError,
} from '../mint-support'
import { _clearMintProgramCacheForTests } from '#modules/executor/builders/token-program'

const TEST_MINT = new PublicKey('So11111111111111111111111111111111111111112')
const HOOK_PROGRAM = new PublicKey('Hook1111111111111111111111111111111111111111')
const HOOK_AUTHORITY = new PublicKey('Auth1111111111111111111111111111111111111111')

/** SPL Token Mint layout = 82 bytes; decimals at byte 44. */
function buildSplMintAccount(owner: PublicKey, decimals = 9) {
  const data = Buffer.alloc(82)
  data[44] = decimals
  return { executable: false, owner, lamports: 0, data, rentEpoch: 0 }
}

/**
 * Build a Token-2022 mint account with an optional list of TLV
 * extensions. Layout per `@solana/spl-token`:
 *   [0..82)  : base Mint
 *   [82..165): padding (zeroed)
 *   [165]    : account-type discriminator (1 = Mint)
 *   [166..)  : TLV entries — each [type u16 LE][len u16 LE][data]
 */
function buildToken2022MintAccount(
  decimals: number,
  extensions: Array<{ type: ExtensionType; data: Buffer }>,
) {
  const tlvSize = extensions.reduce((sum, e) => sum + 4 + e.data.length, 0)
  const data = Buffer.alloc(166 + tlvSize)
  data[44] = decimals
  data[165] = 1 // ACCOUNT_TYPE_SIZE for Mint
  let offset = 166
  for (const ext of extensions) {
    data.writeUInt16LE(ext.type, offset)
    data.writeUInt16LE(ext.data.length, offset + 2)
    ext.data.copy(data, offset + 4)
    offset += 4 + ext.data.length
  }
  return {
    executable: false,
    owner: TOKEN_2022_PROGRAM_ID,
    lamports: 0,
    data,
    rentEpoch: 0,
  }
}

/** TransferHook extension data: [authority 32][programId 32]. */
function transferHookData(authority: PublicKey, programId: PublicKey): Buffer {
  return Buffer.concat([authority.toBuffer(), programId.toBuffer()])
}

describe('assertExecutorSupportsMint', () => {
  beforeEach(() => {
    _clearMintProgramCacheForTests()
  })

  it('MINT-SUPPORT-001: accepts a plain SPL Token mint', async () => {
    const chain = new ScriptedChain({
      accounts: { [TEST_MINT.toBase58()]: buildSplMintAccount(TOKEN_PROGRAM_ID) },
    })

    await expect(assertExecutorSupportsMint(chain, TEST_MINT)).resolves.toBeUndefined()
  })

  it('MINT-SUPPORT-002: accepts a plain Token-2022 mint with no extensions', async () => {
    const chain = new ScriptedChain({
      accounts: {
        [TEST_MINT.toBase58()]: buildToken2022MintAccount(6, []),
      },
    })

    await expect(assertExecutorSupportsMint(chain, TEST_MINT)).resolves.toBeUndefined()
  })

  it('MINT-SUPPORT-003: rejects Token-2022 + TransferHook (non-zero program)', async () => {
    const chain = new ScriptedChain({
      accounts: {
        [TEST_MINT.toBase58()]: buildToken2022MintAccount(6, [
          {
            type: ExtensionType.TransferHook,
            data: transferHookData(HOOK_AUTHORITY, HOOK_PROGRAM),
          },
        ]),
      },
    })

    await expect(assertExecutorSupportsMint(chain, TEST_MINT)).rejects.toMatchObject({
      name: 'UnsupportedMintExtensionError',
      statusCode: 422,
      code: 'unsupported_mint_extension',
      details: { mint: TEST_MINT.toBase58(), extension: 'TransferHook' },
    })
  })

  it('MINT-SUPPORT-004: rejects Token-2022 + NonTransferable', async () => {
    const chain = new ScriptedChain({
      accounts: {
        [TEST_MINT.toBase58()]: buildToken2022MintAccount(6, [
          { type: ExtensionType.NonTransferable, data: Buffer.alloc(0) },
        ]),
      },
    })

    await expect(assertExecutorSupportsMint(chain, TEST_MINT)).rejects.toMatchObject({
      code: 'unsupported_mint_extension',
      details: { extension: 'NonTransferable' },
    })
  })

  it('MINT-SUPPORT-005: rejects Token-2022 + PermanentDelegate', async () => {
    const chain = new ScriptedChain({
      accounts: {
        [TEST_MINT.toBase58()]: buildToken2022MintAccount(6, [
          { type: ExtensionType.PermanentDelegate, data: HOOK_AUTHORITY.toBuffer() },
        ]),
      },
    })

    await expect(assertExecutorSupportsMint(chain, TEST_MINT)).rejects.toMatchObject({
      code: 'unsupported_mint_extension',
      details: { extension: 'PermanentDelegate' },
    })
  })

  it('MINT-SUPPORT-006: rejects Token-2022 + ConfidentialTransferMint', async () => {
    // ConfidentialTransferMint extension layout is large; we only need the
    // type tag to be present for `getExtensionData` to return non-null.
    // 65 bytes covers the documented size; zero-filled is fine.
    const chain = new ScriptedChain({
      accounts: {
        [TEST_MINT.toBase58()]: buildToken2022MintAccount(6, [
          { type: ExtensionType.ConfidentialTransferMint, data: Buffer.alloc(65) },
        ]),
      },
    })

    await expect(assertExecutorSupportsMint(chain, TEST_MINT)).rejects.toMatchObject({
      code: 'unsupported_mint_extension',
      details: { extension: 'ConfidentialTransferMint' },
    })
  })

  it('MINT-SUPPORT-007: accepts Token-2022 + TransferHook with the zero-pubkey sentinel', async () => {
    // "No hook configured" sentinel — extension is present but its
    // programId is the default pubkey. `resolveMintProgram` correctly
    // reports `hasTransferHook = false` here.
    const chain = new ScriptedChain({
      accounts: {
        [TEST_MINT.toBase58()]: buildToken2022MintAccount(6, [
          {
            type: ExtensionType.TransferHook,
            data: transferHookData(HOOK_AUTHORITY, PublicKey.default),
          },
        ]),
      },
    })

    await expect(assertExecutorSupportsMint(chain, TEST_MINT)).resolves.toBeUndefined()
  })

  it('MINT-SUPPORT-008: performs exactly one RPC read per call', async () => {
    const chain = new ScriptedChain({
      accounts: { [TEST_MINT.toBase58()]: buildSplMintAccount(TOKEN_PROGRAM_ID) },
    })

    await assertExecutorSupportsMint(chain, TEST_MINT)

    const accountReads = chain.calls.filter((c) => c.method === 'getAccountInfo')
    expect(accountReads).toHaveLength(1)
    expect(accountReads[0].args[0]).toBe(TEST_MINT.toBase58())
  })

  it('MINT-SUPPORT-009: thrown error is a ValidationError with the documented shape', async () => {
    const chain = new ScriptedChain({
      accounts: {
        [TEST_MINT.toBase58()]: buildToken2022MintAccount(6, [
          {
            type: ExtensionType.TransferHook,
            data: transferHookData(HOOK_AUTHORITY, HOOK_PROGRAM),
          },
        ]),
      },
    })

    let caught: unknown = null
    try {
      await assertExecutorSupportsMint(chain, TEST_MINT)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(UnsupportedMintExtensionError)
    const err = caught as UnsupportedMintExtensionError
    expect(err.statusCode).toBe(422)
    expect(err.code).toBe('unsupported_mint_extension')
    expect(err.details).toEqual({
      mint: TEST_MINT.toBase58(),
      extension: 'TransferHook',
    })
  })
})
