/**
 * Production `CloseQuoteAdapter` for the pre-flight close quote
 * service (close/02). Delegates `computeSwapOut` to the live DLMM
 * chain-direct read in `dlmm.chain.ts::getSwapQuote`.
 *
 * Scope-down. The full close-quote read needs the position's `lbPair`,
 * `positionPubkey`, and stealth ATAs to compute post-close balances
 * (`readPostCloseBalances`) and the mint precheck pubkey
 * (`assertMintSupported`). Those don't live on `PositionRow` yet —
 * production wiring for them lands once the position aggregate gains a
 * stealth-context resolver. Until then this adapter throws
 * `CloseQuoteWiringIncompleteError` from the dependent methods so
 * production deployments surface a clear 503 at the route layer rather
 * than fabricating numbers.
 *
 * What this adapter does land in production today:
 *   - `computeSwapOut` — real DLMM swap quote via `getSwapQuote`,
 *     reusing the same code path the browser-side swap-quote endpoint
 *     uses. Takes `otherSideMint`/`positionPool` from the caller (the
 *     close-quote service already plumbs `otherSideMint` through
 *     `readPostCloseBalances`).
 *   - `resolveDenomination` — null-safe pass-through that surfaces the
 *     close/05 caveat honestly. Returns null when the denomination
 *     wasn't persisted; the UI renders "Denomination: unknown" rather
 *     than a fabricated value.
 */
import { UpstreamError } from "#common/errors";
import { getSwapQuote } from "#modules/dlmm/dlmm.chain";
import type { Network } from "#modules/dlmm/dlmm.types";

import type { CloseQuoteAdapter } from "../position.close-quote.service";
import type { PositionRepository } from "../position.repository";

export class CloseQuoteWiringIncompleteError extends UpstreamError {
  constructor(method: string, missing: string) {
    super(
      `Production CloseQuoteAdapter cannot run ${method}: missing ${missing}. ` +
        `Persist the field on PositionRow or pass a position-context resolver.`,
      { statusCode: 503, code: "close_quote_wiring_incomplete" },
    );
    this.name = "CloseQuoteWiringIncompleteError";
  }
}

/**
 * Per-position context the close-quote production wiring needs. Same
 * scope-down as `CloseOrchestrationPositionContext` (see
 * `production-close.adapter.ts`): until `PositionRow` persists this,
 * a resolver is the migration seam.
 */
export interface CloseQuotePositionContext {
  /** DLMM pool pubkey (base58). */
  poolAddress: string;
  /** Network the pool lives on. */
  network: Network;
  /**
   * Direction of swap: `true` when the non-SOL residual is `tokenX`
   * being routed to `tokenY` (SOL). The DLMM SDK uses this flag to
   * pick the bin-array walk direction; misreading reverses the quote.
   */
  swapForY: boolean;
  /**
   * Expected post-close stealth balances. The production resolver
   * computes these from current bin liquidity + accrued fees per the
   * position's range; until that lands, the close-quote service can
   * use a partial resolver that fills in only `computeSwapOut`-shaped
   * data and rejects on the other methods.
   */
  postCloseBalances: Awaited<ReturnType<CloseQuoteAdapter["readPostCloseBalances"]>>;
  /**
   * Mixer Pool denomination this position originally used. Null when
   * the close/05 caveat applies (denomination not yet persisted).
   */
  denomination: bigint | null;
  /** Optional Token-2022 extension blocker; throws when set. */
  unsupportedMintExtension?: { mint: string; extension: string } | null;
}

export type CloseQuoteContextResolver = (positionId: string) => Promise<CloseQuotePositionContext>;

export interface ProductionCloseQuoteAdapterDeps {
  positionRepo: PositionRepository;
  contextResolver?: CloseQuoteContextResolver;
}

export function createProductionCloseQuoteAdapter(
  deps: ProductionCloseQuoteAdapterDeps,
): CloseQuoteAdapter {
  async function loadCtx(positionId: string, method: string): Promise<CloseQuotePositionContext> {
    if (!deps.contextResolver) {
      throw new CloseQuoteWiringIncompleteError(method, "contextResolver");
    }
    return deps.contextResolver(positionId);
  }

  return {
    async readPostCloseBalances({ positionId }) {
      const ctx = await loadCtx(positionId, "readPostCloseBalances");
      return ctx.postCloseBalances;
    },

    async computeSwapOut({ positionId, otherSideLamports }) {
      const ctx = await loadCtx(positionId, "computeSwapOut");
      const quote = await getSwapQuote(ctx.poolAddress, ctx.network, {
        amountIn: otherSideLamports,
        swapForY: ctx.swapForY,
      });
      return {
        expectedOutLamports: BigInt(quote.expectedOut),
        feeLamports: BigInt(quote.feeLamports),
        priceImpact: quote.priceImpact,
      };
    },

    async assertMintSupported({ positionId }) {
      const ctx = await loadCtx(positionId, "assertMintSupported");
      if (!ctx.unsupportedMintExtension) return;
      // Mirror the documented `UnsupportedMintExtensionError` shape;
      // close-quote service matches on `err.name` + `details`, so we
      // construct a compatible error inline.
      const err = new Error(
        `Mint ${ctx.unsupportedMintExtension.mint} carries an unsupported Token-2022 extension (${ctx.unsupportedMintExtension.extension}).`,
      );
      err.name = "UnsupportedMintExtensionError";
      (err as Error & { details: unknown }).details = ctx.unsupportedMintExtension;
      throw err;
    },

    async resolveDenomination({ positionId }) {
      const ctx = await loadCtx(positionId, "resolveDenomination");
      return ctx.denomination;
    },
  };
}
