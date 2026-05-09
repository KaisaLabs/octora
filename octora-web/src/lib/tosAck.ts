/**
 * Beta ToS / risk-disclosure acknowledgement (P1-36, P1-51).
 *
 * The audit requires every wallet to sign an explicit acknowledgement of
 * the BETA / UNAUDITED risk posture before its first deposit. We record
 * three things per wallet:
 *
 *   - `version`  — the disclosure version they accepted; bumping this in
 *                  source forces every wallet to re-ack.
 *   - `signedAt` — ISO timestamp.
 *   - `signature`— base64 of the wallet's `signMessage` over the
 *                  disclosure body. Non-secret; useful as evidence that
 *                  the user actually signed the version they claim to.
 *
 * Storage is `localStorage` for now. Backend persistence (PUT /tos/ack)
 * is the next step — see runbooks/PRODUCTION_READINESS.md P1-36 for the
 * full server-side schema. Until that lands, a user clearing site data
 * has to ack again, which is the right safety posture anyway.
 */

export const CURRENT_TOS_VERSION = "v1-2026-05-10" as const;

/**
 * The literal string presented to the user inside the modal AND signed
 * via `signMessage`. The signature ties the user's acknowledgement to
 * the exact disclosure they read — bumping this string must come with a
 * `CURRENT_TOS_VERSION` bump so every wallet re-acks.
 */
export const TOS_ACK_MESSAGE = [
  "Octora — beta acknowledgement",
  "",
  `Version: ${CURRENT_TOS_VERSION}`,
  "",
  "I understand and accept that:",
  "",
  "  • Octora is in BETA and the smart contracts are UNAUDITED.",
  "  • A bug in the on-chain programs, the ZK circuit, or the trusted-",
  "    setup ceremony could result in total loss of any deposited funds.",
  "  • The mixer's privacy guarantees depend on a healthy anonymity set;",
  "    very-early withdrawals may be statistically linkable to deposits.",
  "  • Stealth wallets are derived from a wallet signature — losing access",
  "    to the original main wallet means losing access to any unwithdrawn",
  "    stealth balances.",
  "  • The Octora team can pause the protocol but cannot recover lost funds.",
  "",
  "I will not deposit more than I can afford to lose, and I will not hold",
  "Octora liable for losses arising from any of the risks above.",
].join("\n");

interface StoredAck {
  version: string;
  signedAt: string;
  signature: string;
}

const STORAGE_PREFIX = "octora.tos-ack:";

function storageKey(walletAddress: string): string {
  return `${STORAGE_PREFIX}${walletAddress}`;
}

/**
 * `true` when the wallet has already signed the current disclosure
 * version. False after a version bump, even if the wallet acked a
 * previous version — by design.
 */
export function hasAckedTos(walletAddress: string | null | undefined): boolean {
  if (!walletAddress) return false;
  try {
    const raw = localStorage.getItem(storageKey(walletAddress));
    if (!raw) return false;
    const parsed = JSON.parse(raw) as StoredAck;
    return parsed.version === CURRENT_TOS_VERSION;
  } catch {
    return false;
  }
}

/** Persist a successful ack. The signature is base64 of the wallet's signMessage. */
export function recordTosAck(args: {
  walletAddress: string;
  signature: string;
}): void {
  const ack: StoredAck = {
    version: CURRENT_TOS_VERSION,
    signedAt: new Date().toISOString(),
    signature: args.signature,
  };
  localStorage.setItem(storageKey(args.walletAddress), JSON.stringify(ack));
}

/** Drop any stored ack for the wallet — used in tests and on explicit revoke. */
export function clearTosAck(walletAddress: string): void {
  localStorage.removeItem(storageKey(walletAddress));
}
