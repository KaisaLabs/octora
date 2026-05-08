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

export function removeLocalPosition(walletAddress: string, positionId: string): void {
  if (!walletAddress || typeof window === "undefined") return;
  const current = listLocalPositions(walletAddress);
  const next = current.filter((p) => p.positionId !== positionId);
  window.localStorage.setItem(storageKey(walletAddress), JSON.stringify(next));
  notifyChanged();
}
