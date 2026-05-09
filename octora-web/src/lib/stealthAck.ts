/**
 * One-shot per-wallet flag for the stealth-explainer modal (P1-38).
 *
 * The user only needs to see the recovery-model explainer the first
 * time they intend to make a private deposit. Storing the flag per
 * wallet (not globally) means switching to a new wallet shows the
 * explainer again — which is correct, because a new user needs the
 * same context as the previous one.
 *
 * Pure localStorage shim. Backend persistence is unnecessary: this is
 * UX state, not a security gate.
 */

const STORAGE_PREFIX = "octora.stealth-ack:";

function key(walletAddress: string): string {
  return `${STORAGE_PREFIX}${walletAddress}`;
}

export function hasSeenStealthExplainer(walletAddress: string | null | undefined): boolean {
  if (!walletAddress) return false;
  try {
    return localStorage.getItem(key(walletAddress)) === "1";
  } catch {
    return false;
  }
}

export function markStealthExplainerSeen(walletAddress: string): void {
  try {
    localStorage.setItem(key(walletAddress), "1");
  } catch {
    /* localStorage unavailable / private mode — non-fatal, just re-prompt next time */
  }
}

export function clearStealthExplainerAck(walletAddress: string): void {
  try {
    localStorage.removeItem(key(walletAddress));
  } catch {
    /* ignore */
  }
}
