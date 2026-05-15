import { useEffect, useState } from "react";

/**
 * Source of truth for "can this Position be closed via the Private
 * Position Close flow right now?" — wraps the backend's close-quote
 * precheck (ticket 02: `GET /positions/:positionId/close-quote`).
 *
 * Two consumers:
 *   1. The Close button (ticket 01) — disables itself + renders a tooltip
 *      when `closeable === false`.
 *   2. The portfolio Position list row — renders a "v2" badge on
 *      un-closeable positions so the user sees the constraint before
 *      clicking through.
 *
 * Design notes:
 *   - **Gracefully degrades when the close-quote endpoint doesn't exist
 *     yet** (ticket 02 hasn't shipped) — a 404 is treated as "no
 *     information; assume closeable". This avoids painting every row red
 *     during the rollout window.
 *   - **Explicit `closeable: false` is sticky** — once the backend has
 *     told us a Position is blocked by an unsupported mint extension, we
 *     surface that until the user navigates away. No polling.
 *   - Hook is intentionally thin (no React Query) to keep it usable from
 *     anywhere in the tree without a provider dependency. Backend reads
 *     are cached upstream by `resolveMintProgram`'s 5-min TTL.
 *
 * Wire-in for the Close button (ticket 01 follow-up):
 * ```tsx
 * const { closeable, reason, extension } = useCanClosePosition(positionId);
 * <Button disabled={closeable === false} title={
 *   closeable === false
 *     ? `Close is not yet available for pools that include ${extension} mints. This is a v2 capability.`
 *     : undefined
 * } />
 * ```
 */
const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

/** Variant of `BlockedExtension` shared with the API. Kept inline to
 *  avoid a cross-package type import — the union is small and stable
 *  (the Executor's blocked set is also intentionally short). */
export type ClosePositionBlockedExtension =
  | "TransferHook"
  | "NonTransferable"
  | "ConfidentialTransferMint"
  | "PermanentDelegate";

export type CanClosePositionStatus =
  | { status: "loading" }
  | { status: "closeable" }
  | { status: "unknown" } // network failure or endpoint not yet deployed
  | {
      status: "blocked";
      reason: "unsupported_mint";
      mint: string;
      extension: ClosePositionBlockedExtension;
    };

export interface UseCanClosePositionResult {
  isLoading: boolean;
  /** `true` when the API explicitly green-lit the close. `false` when
   *  blocked. `null` while loading or when we don't know yet (404 etc.). */
  closeable: boolean | null;
  /** Stable backend code when blocked — `"unsupported_mint"` is the only
   *  one ticket 02 ships with, but the field is open for future reasons. */
  reason: string | null;
  /** Which extension blocked the close, if applicable. */
  extension: ClosePositionBlockedExtension | null;
  /** Pubkey (base58) of the offending mint when blocked. */
  mint: string | null;
}

/** Shape of `GET /positions/:positionId/close-quote` (per ticket 02). */
interface CloseQuoteResponse {
  closeable: boolean;
  reason?: string;
  details?: { mint?: string; extension?: ClosePositionBlockedExtension };
}

export function useCanClosePosition(
  positionId: string | null | undefined,
): UseCanClosePositionResult {
  const [state, setState] = useState<CanClosePositionStatus>({ status: "loading" });

  useEffect(() => {
    if (!positionId) {
      setState({ status: "unknown" });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    (async () => {
      try {
        const res = await fetch(
          `${API_BASE}/positions/${encodeURIComponent(positionId)}/close-quote`,
        );

        // Endpoint not deployed yet (ticket 02 lands later) — fall back
        // to "unknown" so callers don't paint un-closeable UI by accident.
        if (res.status === 404) {
          if (!cancelled) setState({ status: "unknown" });
          return;
        }

        if (!res.ok) {
          if (!cancelled) setState({ status: "unknown" });
          return;
        }

        const body = (await res.json()) as CloseQuoteResponse;
        if (cancelled) return;

        if (body.closeable === false && body.reason === "unsupported_mint") {
          const extension = body.details?.extension ?? "TransferHook";
          const mint = body.details?.mint ?? "";
          setState({
            status: "blocked",
            reason: "unsupported_mint",
            mint,
            extension,
          });
          return;
        }

        setState({ status: "closeable" });
      } catch {
        if (!cancelled) setState({ status: "unknown" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [positionId]);

  switch (state.status) {
    case "loading":
      return { isLoading: true, closeable: null, reason: null, extension: null, mint: null };
    case "closeable":
      return { isLoading: false, closeable: true, reason: null, extension: null, mint: null };
    case "blocked":
      return {
        isLoading: false,
        closeable: false,
        reason: state.reason,
        extension: state.extension,
        mint: state.mint,
      };
    case "unknown":
    default:
      return { isLoading: false, closeable: null, reason: null, extension: null, mint: null };
  }
}
