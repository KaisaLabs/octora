import { Connection, Transaction } from "@solana/web3.js";
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
