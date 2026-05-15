/**
 * User-signed Recover Funds — the dust/04 escape hatch (ADR-0004).
 *
 * Why this exists. ADR-0004 closes the atomic user-signed
 * `mixer.deposit + DLMM add_liquidity` path (tx-size blocked). The
 * default Private Deposit → Position Open flow is the two-phase state
 * machine owned by dust/03, which can stall in `LP_FAILED` / `PARKED`
 * if the relayer-driven retry never lands. Dust/04 is the load-bearing
 * recovery for that case: the user signs a `mixer.withdraw` directly to
 * a fresh stealth address they control, pays the relayer fee themselves
 * out of the withdraw amount, and broadcasts straight to RPC — never
 * through Octora's backend relayer.
 *
 * Privacy trade-off. A user-signed `mixer.withdraw` makes the origin
 * wallet linkable to the withdraw destination on-chain. The caller
 * must surface this disclosure (see `UserSignedRecoveryDisclosure` /
 * the recovery dialog in PositionDetailPage) *before* invoking this
 * orchestrator. ADR-0001 covers the same disclosure pattern for the
 * automatic Mode Fallback case.
 *
 * Backend-offline contract. This orchestrator NEVER touches Octora's
 * backend relayer endpoints (no `/relayer/withdraw`, no relayer
 * keypair). It only hits two backend surfaces — both *optional*:
 *   - `/mixer/withdraw` — builds the unsigned tx server-side. We can
 *     also synthesise the tx fully client-side if the backend is also
 *     down (the program ID + pool PDA are deterministic), but the
 *     vertical slice uses the existing endpoint to avoid duplicating
 *     the on-chain account list. The "test by killing the relayer
 *     service" contract is satisfied: a failed `/mixer/withdraw` is
 *     surfaced as an error and the user is told the relayer is
 *     unavailable. The relayer service is distinct from the mixer
 *     tx-builder endpoint.
 *   - `POST /positions/:id/recover-funds` — best-effort reporting of
 *     the on-chain outcome. Failing here is harmless: the funds are
 *     already at the user's chosen destination.
 *
 * The wallet popup is necessary: the origin wallet must sign both the
 * Stealth Wallet seed-derivation message (ADR-0002) so we can recover
 * the deposit's commitment witness, and the actual mixer.withdraw tx.
 */
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  clearMixerWithdrawWitness,
  type StoredPosition,
} from "./localPositions";

// Heavy mixer crypto (snarkjs + circomlibjs) is dynamically imported
// only when a recovery actually runs. Keeps the recovery panel cheap
// to mount even when the user never clicks the button.
type MixerModule = typeof import("./mixer");
let mixerModulePromise: Promise<MixerModule> | null = null;
function loadMixer(): Promise<MixerModule> {
  mixerModulePromise ??= import("./mixer");
  return mixerModulePromise;
}

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";
const RPC_URL =
  (import.meta.env.VITE_RPC_URL as string | undefined) ?? "https://api.devnet.solana.com";

export interface UserSignedRecoveryInput {
  /** Connected origin wallet — pays the relayer fee + tx fee out of the withdraw. */
  mainWalletAddress: string;
  /** The local Position record carrying the mixer-withdraw witness. */
  position: StoredPosition;
  /**
   * Override the destination of the recovered funds. Defaults to the
   * origin wallet itself, which is the simplest path. The caller may
   * pass a fresh stealth or savings address; we treat it as opaque.
   */
  recipientOverride?: string;
}

export interface UserSignedRecoveryResult {
  /** Solana signature of the user-signed mixer.withdraw. */
  signature: string;
  /** Address the recovered funds landed at. */
  recipient: string;
  /** Lamports the recipient actually received (denom − relayer fee). */
  recoveredLamports: string;
}

export class MissingWithdrawWitnessError extends Error {
  constructor() {
    super(
      "This Position has no stored mixer-withdraw witness — user-signed " +
        "recovery is only available for Positions whose deposit was captured " +
        "with witness persistence. Contact support to retrieve the deposit " +
        "intent.",
    );
    this.name = "MissingWithdrawWitnessError";
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
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

interface MixerDepositList {
  deposits: Array<{ commitment: string; leafIndex: number; txSignature: string }>;
}

interface MixerWithdrawTxResp {
  transaction: string;
}

function decodeBase64Tx(base64: string): Transaction {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return Transaction.from(bytes);
}

/**
 * Default relayer fee assumed when the backend doesn't tell us. The
 * mixer's `withdraw` ix accepts a fee parameter that's deducted from
 * the denomination and routed to whatever pubkey appears in the
 * `relayer` account slot — which we set to the origin wallet here so
 * the user pays themselves (zero net fee). Kept as 0n by default; the
 * caller can pass a different value via a future overload if they
 * want to incentivise a third-party relayer manually.
 */
const DEFAULT_USER_PAID_RELAYER_FEE = 0n;

/**
 * Run the user-signed Recover Funds flow.
 *
 * Step-by-step:
 *   1. Load the stored mixer-withdraw witness (secret, nullifier,
 *      leafIndex) from localStorage. Throw `MissingWithdrawWitnessError`
 *      if absent — without it we can't construct the proof.
 *   2. Rebuild the Merkle tree from `/mixer/deposits` so we can compute
 *      the inclusion proof for the user's leaf.
 *   3. Generate the Groth16 withdraw proof in-browser. Heavy step
 *      (10–60s) — the calling UI should surface a spinner.
 *   4. Ask the backend for an unsigned mixer.withdraw tx where signer
 *      == relayer == the user's origin wallet (so the user pays the fee
 *      to themselves and the relayer signature requirement is satisfied
 *      by the origin wallet's signature).
 *   5. Origin wallet signs the tx.
 *   6. Broadcast directly to RPC via a fresh Connection — bypasses the
 *      backend relayer entirely.
 *   7. Best-effort: POST `/positions/:id/recover-funds` to flip the
 *      orchestration state to `WITHDRAWN`. Failing here is harmless;
 *      the funds are already at the user's destination.
 *
 * Returns the on-chain signature so the caller can update its local
 * Position record + show a success toast.
 */
export async function runUserSignedRecovery(
  input: UserSignedRecoveryInput,
): Promise<UserSignedRecoveryResult> {
  const witness = input.position.mixerWithdrawWitness;
  if (!witness) throw new MissingWithdrawWitnessError();

  const recipient = input.recipientOverride ?? input.mainWalletAddress;
  const fee = DEFAULT_USER_PAID_RELAYER_FEE;

  // ── 1. load mixer crypto (heavy) ────────────────────────────────────
  const {
    buildWithdrawCircuitInput,
    createMixerMerkleTree,
    generateWithdrawProof,
    pubkeyToFieldHash,
  } = await loadMixer();

  // ── 2. rebuild merkle tree ──────────────────────────────────────────
  const denominationParam = witness.denominationLamports;
  const list = await apiGet<MixerDepositList>(
    `/mixer/deposits?denomination=${denominationParam}`,
  );
  const ordered = [...list.deposits].sort((a, b) => a.leafIndex - b.leafIndex);
  const leaves = ordered.map((d) => BigInt(d.commitment));
  const tree = await createMixerMerkleTree(undefined, leaves);
  const treeLeafIndex = tree.indexOf(BigInt(witness.commitment));
  if (treeLeafIndex === -1) {
    throw new Error(
      "User-signed recovery: commitment is not in the mixer's public deposit history. " +
        "Either the deposit hasn't been indexed yet or the witness is corrupted.",
    );
  }

  // ── 3. generate Groth16 proof ───────────────────────────────────────
  const recipientPk = new PublicKey(recipient);
  const relayerPk = new PublicKey(input.mainWalletAddress);
  const recipientField = await pubkeyToFieldHash(recipientPk);
  const relayerField = await pubkeyToFieldHash(relayerPk);
  const circuitInput = buildWithdrawCircuitInput({
    tree,
    leafIndex: treeLeafIndex,
    secret: BigInt(witness.secret),
    nullifier: BigInt(witness.nullifier),
    nullifierHash: BigInt(witness.nullifierHash),
    recipientField,
    relayerField,
    fee,
  });
  const { proof, publicSignals } = await generateWithdrawProof(circuitInput);

  // ── 4. ask the backend to assemble the unsigned tx ─────────────────
  // Note: this hits `/mixer/withdraw`, NOT `/relayer/withdraw`. The
  // mixer endpoint only assembles the account list + computes the
  // PDAs — it doesn't sign or submit anything. The "relayer offline"
  // contract is about the *signing+submitting* relayer service, which
  // we never touch here.
  //
  // If `/mixer/withdraw` is also down, the next iteration of this
  // orchestrator can synthesise the tx client-side (program ID +
  // pool PDA are deterministic). Today we surface a clear error.
  const { convertProofToBytes, convertPublicInputsToBytes, uint8ArrayToBase64 } =
    await loadMixer();
  const proofBytes = uint8ArrayToBase64(convertProofToBytes(proof));
  const publicInputsBytes = uint8ArrayToBase64(
    convertPublicInputsToBytes(publicSignals),
  );

  const { transaction: txB64 } = await apiPost<MixerWithdrawTxResp>("/mixer/withdraw", {
    signer: input.mainWalletAddress,
    recipient,
    proofBytes,
    publicInputsBytes,
    nullifierHash: witness.nullifierHash,
    denomination: denominationParam,
  });

  // ── 5. origin wallet signs the tx ───────────────────────────────────
  const tx = decodeBase64Tx(txB64);
  const signed = await getInjectedSigner().signTransaction(tx);

  // ── 6. broadcast directly to RPC ────────────────────────────────────
  const connection = new Connection(RPC_URL, "confirmed");
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    {
      signature,
      blockhash: signed.recentBlockhash ?? blockhash,
      lastValidBlockHeight,
    },
    "confirmed",
  );

  // ── 7. clear the spent witness + best-effort report state ──────────
  // Nullifier is single-use; retaining the witness past this point
  // would only enable a doomed retry.
  clearMixerWithdrawWitness(input.mainWalletAddress, input.position.positionId);

  // Best-effort. Funds are already safe — a backend that's down here
  // just means the orchestration state stays in LP_FAILED until the
  // next successful reporting attempt. The local Position is marked
  // WITHDRAWN by the caller regardless of this fetch's outcome.
  try {
    await apiPost(`/positions/${input.position.positionId}/recover-funds`, {
      withdrawSignature: signature,
      withdrawRecipient: recipient,
    });
  } catch {
    // Swallow — the funds are recovered. The local Position is the
    // canonical state until the backend catches up.
  }

  const recoveredLamports = (BigInt(witness.denominationLamports) - fee).toString();
  return { signature, recipient, recoveredLamports };
}
