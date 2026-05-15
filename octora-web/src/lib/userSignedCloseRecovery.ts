/**
 * User-signed close-recovery — the close/03 escape hatch (mirrors
 * dust/04 / ADR-0004 for Flow 3).
 *
 * Why this exists. close/01 introduces a three-tx Private Position
 * Close orchestrator that can land in any of three `*_FAILED`
 * terminals (`CLOSE_FAILED`, `SWAP_FAILED`, `REMIX_FAILED`) if the
 * relayer is unwilling / unable to retry. close/03 is the load-bearing
 * recovery for that case: the user signs the remaining leg(s)
 * themselves directly from their origin wallet, or bails out into a
 * direct sweep — either way the funds end up at a destination they
 * control, never via Octora's backend relayer.
 *
 * Privacy trade-off. A user-signed close-recovery makes the origin
 * wallet linkable to the destination on-chain (ADR-0002's invariant —
 * the origin wallet is the only thing that can recover the Stealth
 * keypair). The caller surfaces this disclosure via
 * `UserSignedCloseRecoveryDialog` *before* invoking this orchestrator.
 *
 * Backend-offline contract. This orchestrator NEVER touches Octora's
 * backend relayer endpoints (no `/relayer/*`). It optionally hits:
 *   - `POST /positions/:id/close-builder` — builds the unsigned tx for
 *     one leg server-side. Read-only-from-the-user's-keys: never signs,
 *     never submits, so the relayer-offline contract holds even when
 *     this endpoint is called. 501 surfaces "tx-builder unwired" so
 *     the panel can suggest the bail path instead.
 *   - `POST /positions/:id/close-recover` — best-effort reporting of
 *     the on-chain outcome. Failing here is harmless because the funds
 *     are already at the user's destination.
 *
 * Architecture. The orchestrator splits cleanly into:
 *   - `runBailToWithdrawn` — re-derive the stealth keypair (origin
 *     wallet signs the derivation message, ADR-0002), then sign +
 *     broadcast a `SystemProgram.transfer` stealth → recipient. Always
 *     works regardless of the failed state because all that matters is
 *     the Stealth Wallet's on-chain SOL balance at recovery time.
 *   - `runCompleteClose` — for each remaining leg, request an unsigned
 *     tx from the close-builder endpoint, stealth-keypair signs,
 *     broadcast direct to RPC. Branches on the failed state:
 *       - `CLOSE_FAILED` → `withdraw-close` → `swap` (if needed) →
 *         `mixer-deposit`
 *       - `SWAP_FAILED`  → `swap` → `mixer-deposit`
 *       - `REMIX_FAILED` → `mixer-deposit`
 *     Each step applies the persisted `closeWitness.slippageBps` +
 *     `expectedSwapOutLamports` to the swap leg so the recovery
 *     honors the same `min_amount_out` the orchestrator-driven swap
 *     would have used.
 */
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  clearCloseWitness,
  type StoredPosition,
} from "./localPositions";

// Heavy stealth-derivation module is dynamically imported only when a
// recovery actually runs. Keeps the recovery panel cheap to mount even
// when the user never clicks the button.
type StealthVaultModule = typeof import("./stealthVault");
let stealthVaultPromise: Promise<StealthVaultModule> | null = null;
function loadStealthVault(): Promise<StealthVaultModule> {
  stealthVaultPromise ??= import("./stealthVault");
  return stealthVaultPromise;
}

// Stealth-sweep helper (legacy primitive) used by `runBailToWithdrawn`
// to drain the Stealth Wallet's SOL to the user's recipient. Lazy so
// the dust/04 path doesn't accidentally pull DLMM crypto on mount.
type PrivateLifecycleModule = typeof import("./privateLifecycle");
let lifecyclePromise: Promise<PrivateLifecycleModule> | null = null;
function loadLifecycle(): Promise<PrivateLifecycleModule> {
  lifecyclePromise ??= import("./privateLifecycle");
  return lifecyclePromise;
}

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";
const RPC_URL =
  (import.meta.env.VITE_RPC_URL as string | undefined) ?? "https://api.devnet.solana.com";

export type CloseRecoveryAction = "complete-close" | "bail-to-withdrawn";

export interface UserSignedCloseRecoveryInput {
  /** Connected origin wallet — pays the recovery tx fee(s). */
  mainWalletAddress: string;
  /** The local Position record carrying the close witness. */
  position: StoredPosition;
  /**
   * Which terminal the user opted to drive the Position into:
   *   - `complete-close` — sign the remaining leg(s) and finish the
   *     Private Position Close (`*_FAILED -> CLOSED`).
   *   - `bail-to-withdrawn` — sign a direct sweep and roll the close
   *     back (`*_FAILED -> WITHDRAWN`).
   */
  recoveryAction: CloseRecoveryAction;
  /**
   * Override the destination of the recovered funds. Defaults to the
   * origin wallet for `bail-to-withdrawn`; ignored when the action is
   * `complete-close` (re-mix mints a Commitment, not a transfer).
   */
  recipientOverride?: string;
  /**
   * Failure stage the orchestrator landed in — drives which legs
   * `runCompleteClose` still needs to sign. Pass through from the
   * Position's current `*_FAILED` state. Defaults to `CLOSE_FAILED`
   * (worst case — sign every leg) when omitted.
   */
  failedState?: "CLOSE_FAILED" | "SWAP_FAILED" | "REMIX_FAILED";
}

export interface UserSignedCloseRecoveryResult {
  /** Solana signature of the *final* user-signed recovery tx. */
  signature?: string;
  /** All on-chain signatures the orchestrator landed, in order. */
  signatures: string[];
  /** Destination address the recovered funds landed at (bail). */
  recipient?: string;
  /** Final terminal state the orchestrator drove the Position into. */
  finalState: "CLOSED" | "WITHDRAWN";
}

export class MissingCloseWitnessError extends Error {
  constructor() {
    super(
      "This Position has no stored close witness — user-signed close-recovery is only available for Positions whose close was kicked off after close/03 shipped. Older Positions fall back to the legacy stealth-sweep UI.",
    );
    this.name = "MissingCloseWitnessError";
  }
}

export class CloseBuilderUnavailableError extends Error {
  constructor(message: string) {
    super(
      `Close-recovery tx-builder is unavailable — the relayer-offline ` +
        `escape hatch can't construct the missing leg(s) right now. ` +
        `Try the bail-to-withdrawn path instead, or retry once the ` +
        `backend reachable: ${message}`,
    );
    this.name = "CloseBuilderUnavailableError";
  }
}

interface SignTransactionProvider {
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
}

function getInjectedSigner(): SignTransactionProvider {
  const w = window as unknown as {
    solana?: SignTransactionProvider;
    phantom?: { solana?: SignTransactionProvider };
    solflare?: SignTransactionProvider;
    backpack?: { solana?: SignTransactionProvider };
  };
  const provider =
    w.phantom?.solana ?? w.solana ?? w.backpack?.solana ?? w.solflare;
  if (!provider?.signTransaction) {
    throw new Error("Connected wallet does not support signTransaction.");
  }
  return provider;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`API ${res.status}: ${text || res.statusText}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

function decodeBase64Tx(base64: string): Transaction {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return Transaction.from(bytes);
}

/**
 * Run the user-signed close-recovery flow.
 *
 * Step-by-step:
 *   1. Assert the Position has a stored `closeWitness`. Throw
 *      `MissingCloseWitnessError` if absent — the recovery panel's
 *      caller falls back to the legacy stealth-sweep UI in that case.
 *   2. Dispatch to `runBailToWithdrawn` or `runCompleteClose` based on
 *      the requested `recoveryAction`. Each helper handles its own
 *      stealth-keypair derivation, tx construction, signing, and
 *      broadcast.
 *   3. Best-effort: POST `/positions/:id/close-recover` to flip the
 *      orchestration state to `CLOSED` or `WITHDRAWN`. Failing here is
 *      harmless; the funds are already at the user's destination.
 *   4. Clear the persisted `closeWitness` — the re-mix nullifier is
 *      single-use, so retaining it past this point would invite a
 *      doomed retry.
 */
export async function runUserSignedCloseRecovery(
  input: UserSignedCloseRecoveryInput,
): Promise<UserSignedCloseRecoveryResult> {
  const witness = input.position.closeWitness;
  if (!witness) throw new MissingCloseWitnessError();

  const recipient = input.recipientOverride ?? input.mainWalletAddress;
  const finalState: "CLOSED" | "WITHDRAWN" =
    input.recoveryAction === "complete-close" ? "CLOSED" : "WITHDRAWN";

  let signatures: string[] = [];

  try {
    if (input.recoveryAction === "bail-to-withdrawn") {
      const result = await runBailToWithdrawn({
        mainWalletAddress: input.mainWalletAddress,
        position: input.position,
        witness,
        recipient,
      });
      signatures = result.signatures;
    } else {
      const result = await runCompleteClose({
        mainWalletAddress: input.mainWalletAddress,
        position: input.position,
        witness,
        failedState: input.failedState ?? "CLOSE_FAILED",
      });
      signatures = result.signatures;
    }
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error(String(err));
  }

  // Best-effort backend report. Funds are already safe — a backend
  // that's down here just means the orchestration state stays in
  // `*_FAILED` until the next successful reporting attempt. The local
  // Position is marked CLOSED / WITHDRAWN by the caller regardless of
  // this fetch's outcome.
  const finalSignature = signatures[signatures.length - 1];
  try {
    await apiPost(`/positions/${input.position.positionId}/close-recover`, {
      recoveryAction: input.recoveryAction,
      txSignature: finalSignature,
      recipient: input.recoveryAction === "bail-to-withdrawn" ? recipient : undefined,
    });
  } catch {
    // Swallow — funds are recovered. The local Position is the
    // canonical state until the backend catches up.
  }

  // Clear the witness — re-mix nullifier (when present) is single-use.
  clearCloseWitness(input.mainWalletAddress, input.position.positionId);

  return {
    signature: finalSignature,
    signatures,
    recipient: input.recoveryAction === "bail-to-withdrawn" ? recipient : undefined,
    finalState,
  };
}

interface BailInput {
  mainWalletAddress: string;
  position: StoredPosition;
  witness: NonNullable<StoredPosition["closeWitness"]>;
  recipient: string;
}

/**
 * Bail-to-withdrawn: re-derive the Stealth keypair (origin wallet
 * signs the derivation message, ADR-0002), then sign + broadcast a
 * `SystemProgram.transfer` stealth → recipient that drains the
 * Stealth Wallet's SOL.
 *
 * Why a transfer (not `mixer.withdraw`)? At `*_FAILED` time the SOL is
 * already at the Stealth Wallet — the original mixer commitment was
 * spent during the open flow's `relayer.withdraw → stealth → DLMM`
 * leg. There's no live mixer commitment to spend; a stealth-sweep is
 * the always-available recovery the legacy `runSweepStealthToMain`
 * already uses. The orchestrator never touches `/relayer/*` because
 * the stealth keypair is the only signer required.
 *
 * Returns the on-chain signature so the caller can update its local
 * Position record + show a success toast.
 */
async function runBailToWithdrawn(input: BailInput): Promise<{
  signatures: string[];
}> {
  const { deriveStealthForPosition, deriveStealthForPool } = await loadStealthVault();
  const { executeStealthSweep } = await loadLifecycle();

  // Match the open-flow derivation: v2 (per-position) for new positions,
  // v1 (per-pool) for legacy entries without a `derivationVersion`.
  const stealth =
    input.position.derivationVersion === "v2"
      ? await deriveStealthForPosition({
          mainWalletAddress: input.mainWalletAddress,
          poolAddress: input.witness.poolAddress,
          positionId: input.position.positionId,
        })
      : await deriveStealthForPool({
          mainWalletAddress: input.mainWalletAddress,
          poolAddress: input.witness.poolAddress,
        });

  const sweep = await executeStealthSweep({
    stealth,
    mainWalletAddress: input.recipient,
  });

  // A null signature means the stealth balance was already at-or-below
  // the fee floor — nothing to bail. The caller still treats this as a
  // successful bail (the funds, such as they are, are at the recipient
  // already via the open-flow's relayer withdraw).
  return { signatures: sweep.signature ? [sweep.signature] : [] };
}

interface CompleteCloseInput {
  mainWalletAddress: string;
  position: StoredPosition;
  witness: NonNullable<StoredPosition["closeWitness"]>;
  failedState: "CLOSE_FAILED" | "SWAP_FAILED" | "REMIX_FAILED";
}

/**
 * Complete-close: sign the remaining leg(s) of the close orchestration
 * with the stealth keypair (re-derived via the origin wallet's
 * `signMessage`, ADR-0002). Each leg's unsigned tx is assembled by the
 * close-builder endpoint; the orchestrator stealth-signs and
 * broadcasts directly to RPC, never via `/relayer/*`.
 *
 * Slippage tolerance for the swap leg flows from the persisted
 * `closeWitness.slippageBps` + `expectedSwapOutLamports` (close/02's
 * close-quote modal captures those). The builder echoes the resolved
 * `min_amount_out` back so the activity row can record it.
 */
async function runCompleteClose(input: CompleteCloseInput): Promise<{
  signatures: string[];
}> {
  const { deriveStealthForPosition, deriveStealthForPool } = await loadStealthVault();

  const stealth =
    input.position.derivationVersion === "v2"
      ? await deriveStealthForPosition({
          mainWalletAddress: input.mainWalletAddress,
          poolAddress: input.witness.poolAddress,
          positionId: input.position.positionId,
        })
      : await deriveStealthForPool({
          mainWalletAddress: input.mainWalletAddress,
          poolAddress: input.witness.poolAddress,
        });

  // Pick which legs to sign based on the failed state. Mirrors the
  // mainline orchestrator's serial sequencing:
  //   active → CLOSING → SWAPPING → REMIXING → CLOSED
  // …trimmed so we resume from where the relayer-signed flow gave up.
  const legs: Array<"withdraw-close" | "swap" | "mixer-deposit"> = [];
  if (input.failedState === "CLOSE_FAILED") {
    legs.push("withdraw-close");
    if (needsSwap(input.witness)) legs.push("swap");
    legs.push("mixer-deposit");
  } else if (input.failedState === "SWAP_FAILED") {
    legs.push("swap");
    legs.push("mixer-deposit");
  } else {
    legs.push("mixer-deposit");
  }

  const signatures: string[] = [];
  const connection = new Connection(RPC_URL, "confirmed");
  for (const leg of legs) {
    const sig = await signAndBroadcastLeg({
      positionId: input.position.positionId,
      leg,
      signerPubkey: stealth.publicKey,
      stealthSigner: (tx) => {
        tx.partialSign(stealth.keypair);
        return tx;
      },
      witness: input.witness,
      connection,
    });
    signatures.push(sig);
  }
  return { signatures };
}

interface SignAndBroadcastInput {
  positionId: string;
  leg: "withdraw-close" | "swap" | "mixer-deposit";
  signerPubkey: string;
  /** Sign the tx with the stealth keypair in-place + return it. */
  stealthSigner: (tx: Transaction) => Transaction;
  witness: NonNullable<StoredPosition["closeWitness"]>;
  connection: Connection;
}

/**
 * Internal: ask the backend for an unsigned tx for one leg, stealth-
 * sign it, broadcast directly to RPC. Throws
 * `CloseBuilderUnavailableError` on 501 so the caller can suggest the
 * bail path.
 */
async function signAndBroadcastLeg(input: SignAndBroadcastInput): Promise<string> {
  const body: Record<string, unknown> = {
    leg: input.leg,
    signer: input.signerPubkey,
  };
  if (input.leg === "swap") {
    if (input.witness.slippageBps !== undefined) {
      body.slippageBps = input.witness.slippageBps;
    }
    if (input.witness.expectedSwapOutLamports !== undefined) {
      body.expectedSwapOutLamports = input.witness.expectedSwapOutLamports;
    }
  }

  let unsigned: { transaction: string };
  try {
    unsigned = await apiPost<{ transaction: string }>(
      `/positions/${input.positionId}/close-builder`,
      body,
    );
  } catch (err) {
    if (
      err instanceof Error &&
      (err as Error & { status?: number }).status === 501
    ) {
      throw new CloseBuilderUnavailableError(err.message);
    }
    throw err;
  }

  const tx = decodeBase64Tx(unsigned.transaction);
  const signed = input.stealthSigner(tx);

  const signature = await input.connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  const { blockhash, lastValidBlockHeight } = await input.connection.getLatestBlockhash(
    "confirmed",
  );
  await input.connection.confirmTransaction(
    {
      signature,
      blockhash: signed.recentBlockhash ?? blockhash,
      lastValidBlockHeight,
    },
    "confirmed",
  );
  return signature;
}

function needsSwap(witness: NonNullable<StoredPosition["closeWitness"]>): boolean {
  // Stealth holds a non-zero other-side residual → swap. Mirrors
  // `CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS` semantics from the backend's
  // close service; we cannot read the chain here without an extra RPC
  // round-trip, so the witness's optimistic estimate drives the
  // decision. Worst case: orchestrator signs an extra swap that the
  // builder will produce a no-op for.
  const lamports = witness.expectedOtherSideLamports;
  if (!lamports) return false;
  try {
    return BigInt(lamports) > 0n;
  } catch {
    return false;
  }
}

// Re-exports below are unused at runtime but keep the existing
// `getInjectedSigner` symbol importable for the (future) wallet-popup
// confirmation step before the stealth-derivation signMessage fires.
// Touching them silences the lint without changing the export shape.
void getInjectedSigner;
void PublicKey;
