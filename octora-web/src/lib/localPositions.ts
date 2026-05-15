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
  /** Local terminal/failure marker used by the web fallback panels while the
   *  backend state machine catches up. */
  lifecycleStatus?: "LP_FAILED" | "PARKED" | "WITHDRAWN";
  /**
   * Mixer-withdraw witness captured at deposit time. Required by dust/04's
   * user-signed Recover Funds fallback to construct a `mixer.withdraw`
   * proof without depending on the backend relayer.
   *
   * The witness lives entirely in the browser — server never sees the
   * preimages (`secret`, `nullifier`). It is the only thing standing
   * between the user and forever-stuck mixer funds when the relayer
   * disappears mid-flight (the ADR-0004 escape hatch). Cleared once the
   * Position transitions to LP_DONE or WITHDRAWN.
   *
   * Cleared from this struct only after `runUserSignedRecovery` confirms
   * the on-chain withdraw — `nullifier` is single-use, so retaining a
   * witness for a spent commitment would just create user confusion if a
   * second recovery attempt was triggered.
   */
  mixerWithdrawWitness?: {
    /** Field-element secret (decimal string). Hashed into commitment. */
    secret: string;
    /** Field-element nullifier (decimal string). Hashed into nullifierHash. */
    nullifier: string;
    /** Public commitment (decimal string) the mixer accepted on deposit. */
    commitment: string;
    /** Public nullifierHash (decimal string) the withdraw will spend. */
    nullifierHash: string;
    /** Leaf index assigned by the on-chain `next_leaf_index` at deposit. */
    leafIndex: number;
    /** Denomination in lamports (decimal string) of the mixer pool. */
    denominationLamports: string;
  };
  /**
   * close/03 — close-flow witness captured at the moment the close
   * orchestrator kicks off (Flow 3). Required by the user-signed
   * close-recovery fallback to construct the recovery tx(s) without
   * depending on the backend relayer.
   *
   * Mirrors `mixerWithdrawWitness` for dust/04: the witness lives
   * entirely in the browser, the server never sees the preimage of
   * the re-mix commitment, and it is cleared once the Position
   * transitions to CLOSED (clean orchestrator completion) or
   * WITHDRAWN (user-signed recovery landed). For Positions closed
   * before this commit shipped, the witness is simply absent — the
   * recovery panel then falls back to the legacy stealth-sweep UI
   * (same caveat dust/04 carries).
   */
  closeWitness?: {
    /** Pool address the DLMM Position lives on (needed for the dlmm_withdraw_close ix). */
    poolAddress: string;
    /** Stealth wallet that owns the DLMM Position. */
    stealthPubkey: string;
    /** On-chain DLMM Position pubkey. */
    positionPubkey: string;
    /** Mint of the other-side token in the pair (may equal SOL mint for single-sided). */
    otherSideMint?: string;
    /** Denomination in lamports of the Mixer Pool used by the original deposit. */
    denominationLamports: string;
    /**
     * Mixer Pool the re-mix step targets. Same address space as
     * `mixerWithdrawWitness.commitment` — close/03's re-mix path
     * mints a fresh Commitment into this pool, so the preimage
     * below is what the user will need to spend it later.
     */
    mixerPool?: string;
    /**
     * Pre-image for the fresh re-mix Commitment. Captured at
     * orchestrator-kickoff so the user-signed recovery can either
     * (a) complete the close by minting this exact Commitment
     * themselves, or (b) bail to WITHDRAWN and discard it.
     */
    remixPreimage?: {
      /** Field-element secret (decimal string). */
      secret: string;
      /** Field-element nullifier (decimal string). */
      nullifier: string;
      /** Public commitment (decimal string) the re-mix will post. */
      commitment: string;
      /** Public nullifierHash (decimal string) the future withdraw will spend. */
      nullifierHash: string;
    };
    /**
     * Estimated post-close SOL balance of the Stealth Wallet
     * (lamports decimal-string). Drives the recovery panel's
     * "should I expect SOL here?" copy.
     */
    expectedSolLamports?: string;
    /**
     * Estimated post-close other-side balance of the Stealth Wallet
     * (lamports decimal-string of the other-side mint's smallest unit).
     * Zero for single-sided SOL Positions; non-zero for pairs.
     */
    expectedOtherSideLamports?: string;
    /** ms since epoch — when the close orchestrator was first invoked. */
    ts: number;
  };
  /** Position execution-mode metadata mirrored from backend activity when available. */
  mode?: "fast-private" | "standard" | string;
  fallbackMode?: "standard" | "fast-private" | string;
  surfaceDowngradeDisclosure?: boolean;
  safeNextStep?: "wait" | "recover" | "retry" | string;
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

export function markLocalPositionWithdrawn(
  walletAddress: string,
  positionId: string,
  meta: CloseMetadata = {},
): void {
  if (!walletAddress || typeof window === "undefined") return;
  const current = listLocalPositions(walletAddress);
  let changed = false;
  const next = current.map((p) => {
    if (p.positionId !== positionId) return p;
    changed = true;
    return {
      ...p,
      closed: true,
      lifecycleStatus: "WITHDRAWN" as const,
      closedAt: meta.ts ?? Date.now(),
      withdrawSignature: meta.signature,
      withdrawRecipient: meta.recipient,
    };
  });
  if (!changed) return;
  window.localStorage.setItem(storageKey(walletAddress), JSON.stringify(next));
  notifyChanged();
}

/**
 * Persist the mixer-withdraw witness for a Position. Called by the
 * deposit orchestrator once the on-chain `mixer.deposit` has confirmed
 * (we have the leafIndex) so the dust/04 Recover Funds fallback can run
 * later without going back to the network for the preimages.
 *
 * Idempotent: a re-record with the same positionId overwrites the
 * previous witness (e.g. a retry that re-derived the commitment).
 */
export function recordMixerWithdrawWitness(
  walletAddress: string,
  positionId: string,
  witness: NonNullable<StoredPosition["mixerWithdrawWitness"]>,
): void {
  if (!walletAddress || typeof window === "undefined") return;
  const current = listLocalPositions(walletAddress);
  let changed = false;
  const next = current.map((p) => {
    if (p.positionId !== positionId) return p;
    changed = true;
    return { ...p, mixerWithdrawWitness: witness };
  });
  if (!changed) return;
  window.localStorage.setItem(storageKey(walletAddress), JSON.stringify(next));
  notifyChanged();
}

/**
 * Drop a stored mixer-withdraw witness — called once the corresponding
 * nullifier has been spent (after a successful user-signed recovery or
 * a clean LP completion). The nullifier is single-use, so keeping a
 * witness for a spent commitment would invite a second recovery
 * attempt that can only fail on-chain.
 */
export function clearMixerWithdrawWitness(
  walletAddress: string,
  positionId: string,
): void {
  if (!walletAddress || typeof window === "undefined") return;
  const current = listLocalPositions(walletAddress);
  let changed = false;
  const next = current.map((p) => {
    if (p.positionId !== positionId || !p.mixerWithdrawWitness) return p;
    changed = true;
    const { mixerWithdrawWitness: _drop, ...rest } = p;
    void _drop;
    return rest;
  });
  if (!changed) return;
  window.localStorage.setItem(storageKey(walletAddress), JSON.stringify(next));
  notifyChanged();
}

/**
 * close/03 — persist a close-flow witness on a Position. Called by the
 * close orchestrator client-side wrapper at the moment the user clicks
 * "Close + re-mix" and the backend confirms the orchestrator started,
 * so the user-signed recovery path has everything it needs to
 * reconstruct the recovery tx(s) locally if the relayer disappears
 * mid-flight.
 *
 * Idempotent: a re-record with the same positionId overwrites the
 * previous witness (e.g. a retry-close that re-derived the re-mix
 * preimage).
 */
export function recordCloseWitness(
  walletAddress: string,
  positionId: string,
  witness: NonNullable<StoredPosition["closeWitness"]>,
): void {
  if (!walletAddress || typeof window === "undefined") return;
  const current = listLocalPositions(walletAddress);
  let changed = false;
  const next = current.map((p) => {
    if (p.positionId !== positionId) return p;
    changed = true;
    return { ...p, closeWitness: witness };
  });
  if (!changed) return;
  window.localStorage.setItem(storageKey(walletAddress), JSON.stringify(next));
  notifyChanged();
}

/**
 * close/03 — drop a stored close witness. Called once the close has
 * either landed CLOSED (clean orchestrator completion or user-signed
 * complete-close) or WITHDRAWN (user-signed bail). The re-mix
 * nullifier is single-use, so keeping the witness around after a
 * terminal would invite a second recovery attempt that can only fail
 * on-chain.
 */
export function clearCloseWitness(
  walletAddress: string,
  positionId: string,
): void {
  if (!walletAddress || typeof window === "undefined") return;
  const current = listLocalPositions(walletAddress);
  let changed = false;
  const next = current.map((p) => {
    if (p.positionId !== positionId || !p.closeWitness) return p;
    changed = true;
    const { closeWitness: _drop, ...rest } = p;
    void _drop;
    return rest;
  });
  if (!changed) return;
  window.localStorage.setItem(storageKey(walletAddress), JSON.stringify(next));
  notifyChanged();
}

export function markLocalPositionLifecycleStatus(
  walletAddress: string,
  positionId: string,
  lifecycleStatus: NonNullable<StoredPosition["lifecycleStatus"]>,
): void {
  if (!walletAddress || typeof window === "undefined") return;
  const current = listLocalPositions(walletAddress);
  let changed = false;
  const next = current.map((p) => {
    if (p.positionId !== positionId) return p;
    changed = true;
    return {
      ...p,
      lifecycleStatus,
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
