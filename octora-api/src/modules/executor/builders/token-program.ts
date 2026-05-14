import { Connection, PublicKey } from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
  getExtensionData,
  ExtensionType,
} from '@solana/spl-token'
import { TtlCache } from '#common/http/ttl-cache'

export type MintProgramInfo =
  | {
      programId: PublicKey
      isToken2022: false
      hasTransferHook: false
      hookProgramId: null
      unsupported: null
    }
  | {
      programId: PublicKey
      isToken2022: true
      hasTransferHook: boolean
      hookProgramId: PublicKey | null
      unsupported: null | UnsupportedExtension
    }

export type UnsupportedExtension =
  | 'NonTransferable'
  | 'ConfidentialTransferMint'
  | 'PermanentDelegate'

const cache = new TtlCache<string, MintProgramInfo>({ ttlMs: 5 * 60_000, max: 2048 })

/**
 * Resolve which token program owns a mint and surface any extensions the
 * tx-builder needs to handle specially. Used everywhere we'd otherwise
 * hardcode `TOKEN_PROGRAM_ID` in an ix's account list or ATA-create call.
 *
 * Cached for 5 min per mint pubkey. Mints don't change extension sets
 * after init, so a long TTL is safe; the cap keeps memory bounded.
 *
 * Returns `unsupported = "NonTransferable" | "ConfidentialTransferMint" |
 * "PermanentDelegate"` when an extension makes the mint incompatible with
 * single-sided LPing (NonTransferable can't move at all; Confidential
 * requires a separate ix family; PermanentDelegate hands an outside party
 * unilateral seize rights on positions). Callers should fail-closed with
 * a clear UI message rather than try to build a tx.
 *
 * TransferHook by itself is NOT unsupported — caller must pull in the
 * `ExtraAccountMetaList` and append the hook's required accounts to the
 * ix (see `expandTransferHookAccounts`).
 */
export async function resolveMintProgram(
  conn: Connection,
  mint: PublicKey,
): Promise<MintProgramInfo> {
  const key = mint.toBase58()
  const cached = cache.get(key)
  if (cached) return cached

  const info = await conn.getAccountInfo(mint, 'confirmed')
  if (!info) {
    throw new Error(`Mint account not found: ${key}`)
  }

  const owner = info.owner
  if (owner.equals(TOKEN_PROGRAM_ID)) {
    const out: MintProgramInfo = {
      programId: TOKEN_PROGRAM_ID,
      isToken2022: false,
      hasTransferHook: false,
      hookProgramId: null,
      unsupported: null,
    }
    cache.set(key, out)
    return out
  }

  if (!owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(
      `Mint ${key} owner ${owner.toBase58()} is neither SPL Token nor Token-2022`,
    )
  }

  const unpacked = unpackMint(mint, info, TOKEN_2022_PROGRAM_ID)
  const tlv = unpacked.tlvData

  // Extensions that make a mint incompatible with the single-sided SOL
  // flow as currently designed. Order matters only for error reporting —
  // we report the first one we hit.
  let unsupported: UnsupportedExtension | null = null
  if (getExtensionData(ExtensionType.NonTransferable, tlv) !== null) {
    unsupported = 'NonTransferable'
  } else if (
    getExtensionData(ExtensionType.ConfidentialTransferMint, tlv) !== null
  ) {
    unsupported = 'ConfidentialTransferMint'
  } else if (getExtensionData(ExtensionType.PermanentDelegate, tlv) !== null) {
    unsupported = 'PermanentDelegate'
  }

  const hookData = getExtensionData(ExtensionType.TransferHook, tlv)
  let hookProgramId: PublicKey | null = null
  if (hookData !== null) {
    // TransferHook extension layout: [authority(32)][programId(32)]
    if (hookData.length >= 64) {
      const pid = new PublicKey(hookData.subarray(32, 64))
      // The "no hook configured" sentinel is the zero pubkey.
      if (!pid.equals(PublicKey.default)) {
        hookProgramId = pid
      }
    }
  }

  const out: MintProgramInfo = {
    programId: TOKEN_2022_PROGRAM_ID,
    isToken2022: true,
    hasTransferHook: hookProgramId !== null,
    hookProgramId,
    unsupported,
  }
  cache.set(key, out)
  return out
}

/** Test-only — clear cached mint resolutions. */
export function _clearMintProgramCacheForTests(): void {
  cache.clear()
}
