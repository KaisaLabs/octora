import type { DistributionShape } from "@/components/octora/types";

/**
 * Local index of private LP positions keyed by main wallet pubkey.
 *
 * The privacy model means the chain doesn't link a wallet to its
 * stealth-owned positions, so the browser is the only place that
 * knows "this wallet just opened position X". We persist the minimal
 * receipt needed to render a portfolio (positionId, pool, range,
 * shape, deposit size) and to locate the on-chain position later
 * (positionPubkey, stealthPubkey).
 */

export interface StoredPosition {
  positionId: string;
  poolAddress: string;
  positionPubkey: string;
  stealthPubkey: string;
  /** Lamports landed on the stealth wallet (denomination − relayer fee). */
  fundedLamports: string;
  /** USD-denominated deposit at the time of the trade. Used as the initial value. */
  depositedUsd: number;
  lowerBinId: number;
  upperBinId: number;
  shape: DistributionShape;
  /** ms since epoch — when the deposit completed. */
  ts: number;
  network: "mainnet" | "devnet" | "localnet";
  /** True once `runWithdrawClose` has settled and the on-chain position has
   *  been closed. The entry stays in the index in this state so the user can
   *  still see (and act on) the SOL sitting at the stealth wallet — call
   *  `removeLocalPosition` only after the funds have been swept out. */
  closed?: boolean;
  /** ms since epoch — when the withdraw_close tx confirmed. Drives the
   *  Activity feed's Withdraw row timestamp. */
  closedAt?: number;
  /** withdraw_close tx signature — surfaced to the Activity feed so the row
   *  links out to an explorer. */
  withdrawSignature?: string;
  /** exit_recipient pubkey returned by the withdraw_close response (where the
   *  funds actually landed before the sweep — usually the stealth itself). */
  withdrawRecipient?: string;
  /** Optional tx signatures captured at deposit time so the Activity page can
   *  link out to an explorer. All four are recorded when available; `fund` is
   *  the canonical "liquidity landed" marker the UI prefers. */
  signatures?: {
    mixerDeposit?: string;
    relayerWithdraw?: string;
    init?: string;
    fund?: string;
  };
  /** Which stealth-derivation scheme this position uses. `"v1"` (or missing)
   *  = per-pool derive; the legacy code path. `"v2"` = per-position derive,
   *  keyed by (wallet, pool, positionId). The orchestrators read this on
   *  recovery to pick which derivation to call. New positions = "v2". */
  derivationVersion?: "v1" | "v2";
}

const KEY_PREFIX = "octora.positions.v1.";

/**
 * Browser-side change event. Subscribed to by the portfolio hook so the
 * UI re-reads localStorage immediately after a deposit, without forcing
 * a refresh. The native `storage` event only fires cross-tab, so we
 * dispatch our own to cover same-tab mutations.
 */
export const POSITIONS_CHANGED_EVENT = "octora:positions:changed";

function notifyChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(POSITIONS_CHANGED_EVENT));
}

function storageKey(walletAddress: string): string {
  return `${KEY_PREFIX}${walletAddress}`;
}

function safeParse(raw: string | null): StoredPosition[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is StoredPosition =>
        p && typeof p === "object" && typeof p.positionId === "string" && typeof p.poolAddress === "string",
    );
  } catch {
    return [];
  }
}

export function listLocalPositions(walletAddress: string | null | undefined): StoredPosition[] {
  if (!walletAddress) return [];
  if (typeof window === "undefined") return [];
  return safeParse(window.localStorage.getItem(storageKey(walletAddress)));
}

export function addLocalPosition(walletAddress: string, position: StoredPosition): void {
  if (!walletAddress || typeof window === "undefined") return;
  const current = listLocalPositions(walletAddress);
  // Idempotent: dedupe by positionId so a retry doesn't double-record.
  const next = [position, ...current.filter((p) => p.positionId !== position.positionId)];
  window.localStorage.setItem(storageKey(walletAddress), JSON.stringify(next));
  notifyChanged();
}

export interface CloseMetadata {
  signature?: string;
  recipient?: string;
  /** Override the close timestamp; defaults to Date.now(). */
  ts?: number;
}

export function markLocalPositionClosed(
  walletAddress: string,
  positionId: string,
  meta: CloseMetadata = {},
): void {
  if (!walletAddress || typeof window === "undefined") return;
  const current = listLocalPositions(walletAddress);
  let changed = false;
  const next = current.map((p) => {
    if (p.positionId !== positionId || p.closed) return p;
    changed = true;
    return {
      ...p,
      closed: true,
      closedAt: meta.ts ?? Date.now(),
      withdrawSignature: meta.signature,
      withdrawRecipient: meta.recipient,
    };
  });
  if (!changed) return;
  window.localStorage.setItem(storageKey(walletAddress), JSON.stringify(next));
  notifyChanged();
}

export interface RebalanceMetadata {
  lowerBinId: number;
  upperBinId: number;
  shape: DistributionShape;
  positionPubkey: string;
  /** add-liquidity tx signature on the new range — replaces the prior `fund`
   *  signature so the Activity feed and explorer link reflect the latest deploy. */
  fundSignature?: string;
}

/**
 * Patch an existing position with the post-rebalance on-chain state. Keeps the
 * positionId stable (the v2 stealth keypair is bound to it) so the portfolio
 * URL and stealth derivation continue to resolve to the same wallet.
 */
export function markLocalPositionRebalanced(
  walletAddress: string,
  positionId: string,
  patch: RebalanceMetadata,
): void {
  if (!walletAddress || typeof window === "undefined") return;
  const current = listLocalPositions(walletAddress);
  let changed = false;
  const next = current.map((p) => {
    if (p.positionId !== positionId) return p;
    changed = true;
    return {
      ...p,
      lowerBinId: patch.lowerBinId,
      upperBinId: patch.upperBinId,
      shape: patch.shape,
      positionPubkey: patch.positionPubkey,
      signatures: {
        ...(p.signatures ?? {}),
        ...(patch.fundSignature ? { fund: patch.fundSignature } : {}),
      },
    };
  });
  if (!changed) return;
  window.localStorage.setItem(storageKey(walletAddress), JSON.stringify(next));
  notifyChanged();
}

export function removeLocalPosition(walletAddress: string, positionId: string): void {
  if (!walletAddress || typeof window === "undefined") return;
  const current = listLocalPositions(walletAddress);
  const next = current.filter((p) => p.positionId !== positionId);
  window.localStorage.setItem(storageKey(walletAddress), JSON.stringify(next));
  notifyChanged();
}
