import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { deriveStealthForPool, type DerivedStealth } from "./stealthVault";

/**
 * Post-deposit lifecycle: claim fees + full-exit close.
 *
 * Both flows are silent stealth signatures (no main-wallet popup once the
 * stealth keypair is derived). exit_recipient is read from the on-chain
 * PoolAuthority and returned to the caller so the UI can surface
 * "Yield address (save this)".
 */

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";
const RPC_URL =
  (import.meta.env.VITE_RPC_URL as string | undefined) ?? "https://api.devnet.solana.com";

interface TestPairConfig {
  tokenX: string;
  tokenY: string;
  lbPair: string;
  binArrayLower: string;
  binArrayUpper: string;
  lowerBinId: number;
  upperBinId: number;
  width: number;
  activeBin: number;
  binStep: number;
  baseFactor: number;
}

export interface ClaimFeesInput {
  mainWalletAddress: string;
  poolAddress: string;
  /** Original deposit range so use-pool reproduces the same bin arrays.
   *  Optional: when omitted, the lib derives the stealth address and reads
   *  the bin range from the on-chain PoolAuthority + DLMM Position so the
   *  user doesn't have to remember the deposit's bins to claim/withdraw. */
  lowerBinId?: number;
  upperBinId?: number;
}

export interface ClaimFeesResult {
  signature: string;
  exitRecipient: string;
}

export interface WithdrawCloseResult {
  signature: string;
  exitRecipient: string;
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

function decodeBase64Tx(base64: string): Transaction {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return Transaction.from(bytes);
}

interface PoolAuthorityResponse {
  pda: string;
  stealthPubkey: string;
  lbPair: string;
  position: string;
  exitRecipient: string;
  // Present when /executor/pool-authority could decode the on-chain position.
  lowerBinId?: number;
  upperBinId?: number;
  width?: number;
  tokenX?: string;
  tokenY?: string;
  binArrayLower?: string;
  binArrayUpper?: string;
  activeBin?: number;
  binStep?: number;
}

/**
 * Resolve a complete `TestPairConfig` for a (wallet, pool) pair.
 *
 * If the caller already knows the bin range (test-page flow), use it
 * directly via /executor/use-pool. Otherwise derive the stealth address,
 * fetch /executor/pool-authority?stealth&lbPair to read the on-chain
 * position's range, and feed that into /executor/use-pool. Either path
 * returns the same `TestPairConfig` shape so the rest of the flow doesn't
 * care which one ran.
 */
async function loadConfig(input: ClaimFeesInput, stealthPubkey: string): Promise<TestPairConfig> {
  if (input.lowerBinId != null && input.upperBinId != null) {
    const width = input.upperBinId - input.lowerBinId + 1;
    return apiPost<TestPairConfig>("/executor/use-pool", {
      lbPair: input.poolAddress,
      width,
      lowerBinId: input.lowerBinId,
    });
  }

  const auth = await apiGet<PoolAuthorityResponse>(
    `/executor/pool-authority?stealth=${stealthPubkey}&lbPair=${input.poolAddress}`,
  );
  if (auth.lowerBinId == null || auth.upperBinId == null) {
    throw new Error(
      "PoolAuthority found but its bin range could not be decoded. The DLMM " +
        "position may not be initialised on this RPC, or the SDK request " +
        "failed — try again or pass an explicit lowerBinId/upperBinId.",
    );
  }
  const width = auth.upperBinId - auth.lowerBinId + 1;
  return apiPost<TestPairConfig>("/executor/use-pool", {
    lbPair: input.poolAddress,
    width,
    lowerBinId: auth.lowerBinId,
  });
}

async function deriveAndConfirm(
  input: ClaimFeesInput,
  buildPath: "/executor/claim-fees-tx" | "/executor/withdraw-close-tx",
): Promise<{ signature: string; exitRecipient: string; stealth: DerivedStealth }> {
  const connection = new Connection(RPC_URL, "confirmed");
  const stealth = await deriveStealthForPool({
    mainWalletAddress: input.mainWalletAddress,
    poolAddress: input.poolAddress,
  });
  const config = await loadConfig(input, stealth.publicKey);

  const { transaction, exitRecipient } = await apiPost<{
    transaction: string;
    exitRecipient: string;
  }>(buildPath, {
    stealth: stealth.publicKey,
    config,
  });

  const tx = decodeBase64Tx(transaction);
  tx.partialSign(stealth.keypair);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  const { lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    { signature, blockhash: tx.recentBlockhash!, lastValidBlockHeight },
    "confirmed",
  );

  return { signature, exitRecipient, stealth };
}

export async function runClaimFees(input: ClaimFeesInput): Promise<ClaimFeesResult> {
  const { signature, exitRecipient } = await deriveAndConfirm(input, "/executor/claim-fees-tx");
  return { signature, exitRecipient };
}

export async function runWithdrawClose(input: ClaimFeesInput): Promise<WithdrawCloseResult> {
  const { signature, exitRecipient } = await deriveAndConfirm(input, "/executor/withdraw-close-tx");
  return { signature, exitRecipient };
}

export interface SweepStealthInput {
  mainWalletAddress: string;
  poolAddress: string;
}

export interface SweepStealthResult {
  /** Transfer signature; null when nothing was transferred (balance below floor). */
  signature: string | null;
  recipient: string;
  /** Lamports moved from stealth → main wallet. 0 when the balance was below the floor. */
  sweptLamports: string;
  /** Lamports left at the stealth wallet to keep it usable / cover sig fees. */
  remainingLamports: string;
  stealthPubkey: string;
}

/** Solana base fee per signature. Our sweep tx is one signature (the stealth)
 *  with no priority fee, so this is exactly what the runtime will deduct. The
 *  transfer amount is set to `balance − fee` so the stealth lands at 0
 *  lamports — required because any final balance between 0 and the
 *  rent-exempt minimum (~890_880) fails simulation with
 *  "insufficient funds for rent". A 0-lamport account is reaped, which is
 *  fine: the keypair is deterministic and the next deposit re-funds it. */
const STEALTH_SWEEP_FEE_LAMPORTS = 5_000n;

/**
 * Option 1: link-revealing direct sweep stealth → main wallet.
 *
 * Re-derives the stealth keypair locally (one wallet sig), reads the SOL
 * balance, and signs a SystemProgram.transfer of (balance − fee reserve) to
 * the connected main wallet. After this lands an on-chain observer can link
 * `mainWallet ↔ stealth ↔ position`, so it should only be offered as the
 * "quick recovery" option — `runPrivateExitToMain` is the privacy-preserving
 * counterpart that mirrors the deposit's mixer round-trip.
 */
export async function runSweepStealthToMain(
  input: SweepStealthInput,
): Promise<SweepStealthResult> {
  const connection = new Connection(RPC_URL, "confirmed");
  const stealth = await deriveStealthForPool({
    mainWalletAddress: input.mainWalletAddress,
    poolAddress: input.poolAddress,
  });
  const stealthPubkey = new PublicKey(stealth.publicKey);
  const recipient = new PublicKey(input.mainWalletAddress);

  const balance = BigInt(await connection.getBalance(stealthPubkey, "confirmed"));
  if (balance <= STEALTH_SWEEP_FEE_LAMPORTS) {
    // Nothing transferable: the only lamports here can't even cover a single
    // signature. Surface a successful no-op so the caller can show "already
    // swept" rather than throwing — this is the natural state after a sweep
    // (account reaped at 0) or before any close has landed.
    return {
      signature: null,
      recipient: recipient.toBase58(),
      sweptLamports: "0",
      remainingLamports: balance.toString(),
      stealthPubkey: stealth.publicKey,
    };
  }

  // Drain to zero. transfer = balance − fee leaves balance − transfer = fee,
  // which the runtime then deducts as the sig fee, ending at 0. Anything
  // between 0 and rent_exempt (~890_880) would fail simulation.
  const transferLamports = balance - STEALTH_SWEEP_FEE_LAMPORTS;

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: stealthPubkey, blockhash, lastValidBlockHeight });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: stealthPubkey,
      toPubkey: recipient,
      // Number coerce is safe up to ~9_007_000 SOL — well past any real balance.
      lamports: Number(transferLamports),
    }),
  );
  tx.partialSign(stealth.keypair);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  return {
    signature,
    recipient: recipient.toBase58(),
    sweptLamports: transferLamports.toString(),
    remainingLamports: STEALTH_SWEEP_FEE_RESERVE.toString(),
    stealthPubkey: stealth.publicKey,
  };
}

/**
 * Option 2 (NOT IMPLEMENTED): privacy-preserving exit that mirrors the deposit
 * mixer round-trip in reverse — stealth → mixer.deposit (one denomination) →
 * ZK proof → relayer.withdraw → main wallet. Resists the stealth ↔ main link
 * that `runSweepStealthToMain` reveals.
 *
 * Implementation sketch (uses primitives already in `privateDeposit.ts`):
 *   1. Read stealth balance; require ≥ denomination + relayer fee + sig fee.
 *   2. Build mixer.deposit (commitment generated client-side; stealth signs).
 *   3. POST `/deposits/confirm-private` so the indexer captures the new leaf.
 *   4. Reconstruct the merkle tree, generate the ZK withdraw proof.
 *   5. POST `/relayer/withdraw` with `recipient = mainWalletAddress` so the
 *      relayer pays the user without ever signing as the stealth wallet.
 *   6. Optionally sweep the residual (balance − denomination) via a follow-up
 *      direct transfer — at that point the privacy of the denomination is
 *      already secured and the residual is dust.
 *
 * The mixer's fixed denomination means partial-balance hand-off needs the
 * residual sweep step; that's a UX call (accept dust loss, or do a second
 * round-trip) rather than a missing primitive.
 */
export async function runPrivateExitToMain(
  _input: SweepStealthInput,
): Promise<SweepStealthResult> {
  throw new Error(
    "Private exit (mixer round-trip) is not implemented yet. Use runSweepStealthToMain " +
      "for now — see the comment on runPrivateExitToMain for the sketch.",
  );
}
