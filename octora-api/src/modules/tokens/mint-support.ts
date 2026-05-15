/**
 * Pre-flight gate that refuses a Private Position Close (or any other flow
 * that would route an Executor CPI through a swap step) when the non-SOL
 * side of the pool is a Token-2022 mint carrying an extension the on-chain
 * Executor cannot yet handle.
 *
 * Failure shape is a structured `ValidationError` (HTTP 422, stable code
 * `unsupported_mint_extension`) with `details = { mint, extension }`, so:
 *   - `POST /positions/:positionId/close` (ticket 01) rejects upfront with
 *     422 instead of leaving the user in `SWAP_FAILED` recovery,
 *   - `GET /positions/:positionId/close-quote` (ticket 02) catches the
 *     error and reshapes it into the documented
 *     `{ closeable: false, reason: "unsupported_mint", details }` body.
 *
 * # Source-of-truth for the blocked set
 *
 * The blocked-extension list is sourced from
 * `octora-executor/src/modules/executor/builders/token-program.ts`
 * (`UnsupportedExtension` union + the `hasTransferHook` flag), which in
 * turn mirrors what the on-chain Executor program in
 * `programs/octora-executor/` is currently wired for: plain SPL Token and
 * plain Token-2022 only. The on-chain side does not parse extensions at
 * all — it accepts both token program IDs and the off-chain builders are
 * the layer that fails-closed on extensions the v2 ix family can't
 * remaining-account-expand yet.
 *
 * That makes the existing `resolveMintProgram` (executor builders) the de
 * facto single source of truth for the supported set; this helper
 * *delegates* to it rather than duplicating the extension list.
 *
 * TODO(consolidate): once an Anchor IDL or a shared schema for "extensions
 * the Executor can route" exists (e.g. as a constant on the Executor
 * program's Config account or generated from the Rust constants module),
 * collapse the two TS callers — `resolveMintProgram` and this assert —
 * onto that shared definition so adding a new supported extension is a
 * one-place change.  See `programs/octora-executor/src/constants.rs` for
 * the on-chain anchor point.
 */
import type { PublicKey } from '@solana/web3.js'

import { ValidationError } from '#common/errors'
import type { SolanaChain } from '#common/solana/chain'
import { resolveMintProgram } from '#modules/executor/builders/token-program'

/**
 * Identifier for the Token-2022 extension that blocked the operation.
 * Matches the variants surfaced by `resolveMintProgram`. Kept as a
 * narrow string union so callers (and ticket 02's close-quote reshape)
 * can switch on it.
 */
export type BlockedExtension =
  | 'TransferHook'
  | 'NonTransferable'
  | 'ConfidentialTransferMint'
  | 'PermanentDelegate'

/**
 * 422 — the operation requires the Executor to route a CPI through the
 * given mint, but the mint carries an extension the Executor cannot yet
 * handle. `details.mint` is base58; `details.extension` is one of the
 * `BlockedExtension` variants. The frontend matches on `code` to render
 * the "Close is not yet available for pools that include {extension} mints"
 * disabled-button tooltip.
 */
export class UnsupportedMintExtensionError extends ValidationError {
  constructor(mint: string, extension: BlockedExtension) {
    super(
      `Mint ${mint} carries an unsupported Token-2022 extension (${extension}); ` +
        `the on-chain Executor cannot route this flow yet. This is a v2 capability.`,
      {
        code: 'unsupported_mint_extension',
        details: { mint, extension },
      },
    )
    this.name = 'UnsupportedMintExtensionError'
  }
}

/**
 * Refuse to proceed if `mint` is a Token-2022 mint with any
 * Executor-blocked extension. Performs **one** RPC read per call (no
 * caching at this layer — the underlying `resolveMintProgram` already
 * keeps a 5-minute per-mint cache, which is enough; an extra layer here
 * would just duplicate that).
 *
 * Throws `UnsupportedMintExtensionError` (422 / `unsupported_mint_extension`).
 * Returns silently on plain SPL Token, plain Token-2022, or any
 * combination of extensions not on the blocked list.
 *
 * ## Integration point for ticket 01 (`POST /positions/:positionId/close`)
 *
 * Add this single line at the top of the close-initiation handler, *after*
 * resolving the Position's non-SOL mint and *before* enqueueing the
 * orchestration. Failing here keeps the Position in `active` rather than
 * letting it slide into `SWAP_FAILED`:
 *
 * ```ts
 * await assertExecutorSupportsMint(chain, nonSolMint)
 * ```
 *
 * ## Integration point for ticket 02 (`GET /positions/:positionId/close-quote`)
 *
 * Wrap in try/catch and reshape:
 *
 * ```ts
 * try {
 *   await assertExecutorSupportsMint(chain, nonSolMint)
 * } catch (err) {
 *   if (err instanceof UnsupportedMintExtensionError) {
 *     return {
 *       closeable: false,
 *       reason: 'unsupported_mint',
 *       details: err.details,
 *     }
 *   }
 *   throw err
 * }
 * ```
 */
export async function assertExecutorSupportsMint(
  chain: SolanaChain,
  mint: PublicKey,
): Promise<void> {
  const info = await resolveMintProgram(chain, mint)
  if (!info.isToken2022) return

  // `unsupported` is the first NonTransferable/Confidential/PermanentDelegate
  // hit; surfaced even when a TransferHook is also present so the user
  // sees the more fundamental incompatibility first.
  if (info.unsupported) {
    throw new UnsupportedMintExtensionError(mint.toBase58(), info.unsupported)
  }
  if (info.hasTransferHook) {
    throw new UnsupportedMintExtensionError(mint.toBase58(), 'TransferHook')
  }
}
