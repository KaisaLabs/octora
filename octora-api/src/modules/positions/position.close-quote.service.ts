/**
 * close/02 — pre-flight close quote service.
 *
 * Powers `GET /positions/:positionId/close-quote`. Returns the expected
 * post-close stealth balances, the SOL output of swapping any non-SOL
 * residual, price impact, the denomination the re-mix will land in, and
 * the sub-denom dust amount that stays at the Stealth Wallet.
 *
 * Two consumers:
 *   1. The Close confirmation modal (close/02 UI) — renders the line
 *      items, gates the slippage selector, and posts the
 *      `slippageBps` back into `POST /positions/:id/close`.
 *   2. The `useCanClosePosition` hook (close/04) — already pre-wired
 *      to this endpoint's `{ closeable: false, reason: "unsupported_mint" }`
 *      shape so the v2 badge / disabled Close button Just Works.
 *
 * Adapter pattern mirrors close/01's `CloseOrchestrationAdapter`:
 *   - The service is pure orchestration + dust-threshold decision logic.
 *   - On-chain reads (current DLMM state, swap quote) sit behind
 *     {@link CloseQuoteAdapter}.
 *   - Production wiring lives in `position.service.ts` once the live
 *     adapter is built; today only the in-memory test adapter exists
 *     (same scope-down precedent close/01 set — the executor's
 *     `buildSwapIx` isn't wired yet, so a production close-quote
 *     adapter would be lying about numbers it can't follow through on).
 *
 * Body shape contract (matches ticket 02):
 *
 *   Success (no swap needed — SOL-only Position or residual below dust):
 *     { closeable: true, estimate: {...}, denomination, dustLamports }
 *
 *   Success (with swap):
 *     { closeable: true, estimate: {...}, swap: {...}, denomination, dustLamports }
 *
 *   Refused (Token-2022 extension the Executor cannot route):
 *     { closeable: false, reason: "unsupported_mint", details: { mint, extension } }
 */
import type { BlockedExtension } from "#modules/tokens/mint-support";
import { PositionNotFoundError } from "#common/errors";

import { CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS } from "./position.close.service";
import type { PositionRepository } from "./position.repository";

/**
 * Pre-flight close-quote payload returned to the browser. Fields are
 * snake-case'd on the wire (matches the existing project style) and
 * bigint values are serialised as decimal strings — the same convention
 * `dlmm/swap-quote` uses for lamports.
 */
export type CloseQuoteResponse =
  | CloseQuoteBlockedResponse
  | CloseQuoteOkResponse;

export interface CloseQuoteBlockedResponse {
  closeable: false;
  /**
   * Stable reason code. `unsupported_mint` is the only one ticket 02
   * ships with (close/04's pre-flight gate), but the field is open for
   * future reasons (e.g. paused pool, insufficient anonymity set on
   * the re-mix Pool).
   */
  reason: "unsupported_mint" | string;
  details: {
    mint?: string;
    extension?: BlockedExtension;
    [key: string]: unknown;
  };
}

export interface CloseQuoteOkResponse {
  closeable: true;
  /**
   * Estimated stealth balances *after* `dlmm_withdraw_close` lands.
   * Lamports as decimal strings.
   */
  estimate: {
    solLamports: string;
    otherSideLamports: string;
    /** Symbol of the non-SOL side, for the UI summary line. */
    otherSideSymbol: string | null;
    /** Accrued fees component of the totals, for the "Earned fees" line. */
    accruedFeeSolLamports: string;
    accruedFeeOtherLamports: string;
  };
  /**
   * Expected swap of the other-side residual → SOL. Omitted when the
   * other side is SOL or the residual is at or below
   * `CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS` — the orchestrator skips the
   * swap step entirely in those cases, so there's nothing to preview.
   */
  swap?: {
    /** Lamports of the other-side residual being routed through the swap. */
    inLamports: string;
    /** Expected SOL output (lamports), Meteora fee already deducted. */
    expectedOutLamports: string;
    /** Meteora fee paid, in output (SOL) lamports. */
    feeLamports: string;
    /**
     * Decimal price impact, e.g. "0.0124" for 1.24 % — string so the
     * caller controls rounding. Sourced from the DLMM SDK's swapQuote.
     */
    priceImpact: string;
  };
  /**
   * Mixer Pool denomination the re-mix step will deposit against.
   * Lamports decimal string. Sourced from the original Position's
   * deposit denomination per ADR-0003.
   */
  denomination: string;
  /**
   * Sub-denom SOL dust that stays at the Stealth Wallet post-close.
   * Lamports decimal string. Always non-negative; zero when the
   * post-close SOL total cleanly divides into one denomination.
   */
  dustLamports: string;
}

/**
 * On-chain read seam for the close-quote service. Production wires the
 * live DLMM provider + mint-precheck behind this interface; tests pass
 * an in-memory stub.
 *
 * Each method is allowed to throw — the service catches one specific
 * shape (`UnsupportedMintExtensionError`) and reshapes it to the
 * documented `closeable: false` body. Other errors bubble out to the
 * controller, which maps them to 5xx per the standard error path.
 */
export interface CloseQuoteAdapter {
  /**
   * Read the stealth wallet's expected post-close balances by adding
   * (current bin liquidity + accrued fees) for the Position's range.
   * Adapters MAY return `otherSideLamports = 0n` for single-sided SOL
   * pools (matches the orchestrator's swap-skip decision).
   */
  readPostCloseBalances(input: {
    positionId: string;
  }): Promise<{
    solLamports: bigint;
    otherSideLamports: bigint;
    otherSideSymbol: string | null;
    /** Mint pubkey of the non-SOL side, used by the executor mint precheck. */
    otherSideMint: string | null;
    accruedFeeSolLamports: bigint;
    accruedFeeOtherLamports: bigint;
  }>;

  /**
   * Compute the SOL output of swapping `otherSideLamports` of the
   * non-SOL token → SOL at the current pool price. Returns Meteora-fee
   * inclusive numbers (the `feeLamports` line is in output-SOL
   * lamports). Adapters MAY throw — the service treats a thrown quote
   * as a hard reject (the close cannot proceed) and surfaces it to the
   * caller per the normal error path.
   */
  computeSwapOut(input: {
    positionId: string;
    otherSideLamports: bigint;
  }): Promise<{
    expectedOutLamports: bigint;
    feeLamports: bigint;
    priceImpact: string;
  }>;

  /**
   * Pre-flight mint check. Resolves silently when the non-SOL side is
   * plain SPL or plain Token-2022 (no blocked extensions). Throws
   * `UnsupportedMintExtensionError` from `#modules/tokens/mint-support`
   * when the Executor cannot route this flow — the service catches the
   * specific class and reshapes to `closeable: false`.
   */
  assertMintSupported(input: { positionId: string }): Promise<void>;

  /**
   * Resolve the Mixer Pool denomination this Position originally
   * deposited against (lamports). The re-mix step will deposit one
   * denomination of SOL into the same-denomination pool per ADR-0003;
   * residual stays at the Stealth Wallet as sub-denom dust.
   *
   * Adapters MAY return `null` when the denomination wasn't persisted
   * yet (close/05's caveat documented in the ticket). Callers must
   * accept that and render "Denomination: unknown" client-side.
   */
  resolveDenomination(input: { positionId: string }): Promise<bigint | null>;
}

export interface CloseQuoteServiceDeps {
  positionRepo: PositionRepository;
  /**
   * Optional — when omitted the service throws on `quote()`. Mirrors
   * close/01's adapter scope-down so the route is wired but rejects
   * cleanly in production until the live adapter lands.
   */
  adapter?: CloseQuoteAdapter;
}

/**
 * Marker for the close/04 mint precheck path so the service can reshape
 * the thrown error without taking a hard dep on the import (the helper
 * is in a sibling module). The instanceof check uses the constructor's
 * `name` to stay decoupled from the import path.
 */
function isUnsupportedMintExtensionError(err: unknown): err is Error & {
  details: { mint: string; extension: BlockedExtension };
} {
  return (
    err instanceof Error &&
    err.name === "UnsupportedMintExtensionError" &&
    // Defensive — older copies of the class might not carry details on
    // the error object, but the canonical mint-support.ts impl does.
    typeof (err as any).details === "object"
  );
}

export class CloseQuoteServiceNotConfiguredError extends Error {
  constructor() {
    super(
      "createCloseQuoteService was constructed without an adapter; quote() is unavailable. " +
        "Wire a CloseQuoteAdapter in the service composition root.",
    );
    this.name = "CloseQuoteServiceNotConfiguredError";
  }
}

export function createCloseQuoteService(deps: CloseQuoteServiceDeps) {
  return {
    /**
     * Compute the pre-flight close quote for `positionId`. See the
     * file-level doc for the response-shape contract.
     */
    async quote(positionId: string): Promise<CloseQuoteResponse> {
      const adapter = deps.adapter;
      if (!adapter) throw new CloseQuoteServiceNotConfiguredError();

      // 0. Existence check up front so a typo in the URL returns 404
      //    instead of the adapter inventing numbers for a missing row.
      const positionRow = await deps.positionRepo.getPositionById(positionId);
      if (!positionRow) throw new PositionNotFoundError(positionId);

      // 1. Mint precheck (close/04 integration point). Reshape the
      //    typed error into the documented `closeable: false` body.
      try {
        await adapter.assertMintSupported({ positionId });
      } catch (err) {
        if (isUnsupportedMintExtensionError(err)) {
          return {
            closeable: false,
            reason: "unsupported_mint",
            details: {
              mint: err.details.mint,
              extension: err.details.extension,
            },
          };
        }
        throw err;
      }

      // 2. Read post-close balances (stealth SOL + other-side + accrued
      //    fees for both). Drives the dust-threshold swap-skip decision.
      const balances = await adapter.readPostCloseBalances({ positionId });

      // 3. Decide whether the conditional swap leg will fire. Mirror
      //    the orchestrator's exact rule so the UI never previews a
      //    swap step the orchestrator would skip (and vice versa).
      const needsSwap = balances.otherSideLamports > CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS;

      let swapPreview: CloseQuoteOkResponse["swap"] | undefined;
      let postSwapSol = balances.solLamports;
      if (needsSwap) {
        const swap = await adapter.computeSwapOut({
          positionId,
          otherSideLamports: balances.otherSideLamports,
        });
        swapPreview = {
          inLamports: balances.otherSideLamports.toString(),
          expectedOutLamports: swap.expectedOutLamports.toString(),
          feeLamports: swap.feeLamports.toString(),
          priceImpact: swap.priceImpact,
        };
        postSwapSol = balances.solLamports + swap.expectedOutLamports;
      }

      // 4. Resolve the re-mix denomination + sub-denom dust amount.
      //    `null` denomination is the close/05 caveat — client renders
      //    "Denomination: unknown" and "Dust: unknown" honestly.
      const denomination = await adapter.resolveDenomination({ positionId });
      const dustLamports =
        denomination !== null && denomination > 0n ? postSwapSol % denomination : 0n;

      return {
        closeable: true,
        estimate: {
          solLamports: balances.solLamports.toString(),
          otherSideLamports: balances.otherSideLamports.toString(),
          otherSideSymbol: balances.otherSideSymbol,
          accruedFeeSolLamports: balances.accruedFeeSolLamports.toString(),
          accruedFeeOtherLamports: balances.accruedFeeOtherLamports.toString(),
        },
        ...(swapPreview ? { swap: swapPreview } : {}),
        denomination: (denomination ?? 0n).toString(),
        dustLamports: dustLamports.toString(),
      };
    },
  };
}

export type CloseQuoteService = ReturnType<typeof createCloseQuoteService>;
