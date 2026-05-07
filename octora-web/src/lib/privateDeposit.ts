import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { deriveStealthForPool, type DerivedStealth } from "./stealthVault";

/**
 * Private deposit orchestrator.
 *
 * Walks the browser through the full lifecycle:
 *   1. derive   — sign a deterministic message → derive stealth keypair (1 wallet popup, free)
 *   2. prepare  — POST /deposits/prepare-private, register the privacy intent server-side
 *   3. use-pool — POST /executor/use-pool, load on-chain pool state and bin arrays
 *   4. init     — POST /executor/init-position-tx, browser adds stealth sig and sends (silent)
 *   5. fund     — POST /executor/add-liquidity-tx, user co-signs the SPL transfer (1 wallet popup)
 *
 * Everything after step 1 happens with one user-visible signature (the funding tx);
 * the stealth keypair signs locally with no popup.
 */

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";
const RPC_URL =
  (import.meta.env.VITE_RPC_URL as string | undefined) ?? "https://api.devnet.solana.com";

export type DepositStepKey =
  | "derive"
  | "prepare"
  | "use-pool"
  | "init-position"
  | "fund-position"
  | "done";

export interface DepositStepEvent {
  step: DepositStepKey;
  status: "active" | "ok" | "error";
  message?: string;
  data?: Record<string, unknown>;
}

export type DepositStepCallback = (event: DepositStepEvent) => void;

export interface PrivateDepositInput {
  /** Connected user main wallet pubkey (base58). */
  mainWalletAddress: string;
  /** DLMM lb_pair address (base58). */
  poolAddress: string;
  /** Inclusive bin range from the BinLiquidityChart. */
  lowerBinId: number;
  upperBinId: number;
  /** Distribution shape — currently informational; passed through to the privacy receipt. */
  shape: "spot" | "curve" | "bid-ask";
  /** Deposit amount in USD — included on the privacy receipt for audit. */
  amountUsd: number;
  /** USD allocation split, used by the receipt only (token amounts come from the fields below). */
  allocation: { tokenA: number; tokenB: number };
  /** Token amounts in base units (BigInt-stringified or bigint). */
  amountX: bigint;
  amountY: bigint;
}

export interface PrivateDepositResult {
  positionId: string;
  stealthPubkey: string;
  positionPubkey: string;
  initSignature: string;
  fundSignature: string;
}

interface SignTransactionProvider {
  signTransaction: (tx: Transaction) => Promise<Transaction>;
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

function decodeBase64Tx(base64: string): Transaction {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return Transaction.from(bytes);
}

interface PreparePrivateResponse {
  positionId: string;
  receipt: {
    receiptId: string;
    podId: string | null;
    status: string;
    summary: string;
    createdAtIso: string;
  };
}

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

interface InitPositionResponse {
  transaction: string;
  positionPubkey: string;
  positionAuthority: string;
}

interface AddLiquidityResponse {
  transaction: string;
}

export async function runPrivateDeposit(
  input: PrivateDepositInput,
  onStep: DepositStepCallback = () => {},
): Promise<PrivateDepositResult> {
  const width = input.upperBinId - input.lowerBinId + 1;
  if (width <= 0) throw new Error("upperBinId must be >= lowerBinId.");

  const connection = new Connection(RPC_URL, "confirmed");

  // ── 1. derive stealth keypair from a wallet signature ────────────────
  onStep({ step: "derive", status: "active", message: "Authorize private session in your wallet…" });
  let stealth: DerivedStealth;
  try {
    stealth = await deriveStealthForPool({
      mainWalletAddress: input.mainWalletAddress,
      poolAddress: input.poolAddress,
    });
  } catch (err) {
    onStep({ step: "derive", status: "error", message: describe(err) });
    throw err;
  }
  onStep({
    step: "derive",
    status: "ok",
    data: { stealthPubkey: stealth.publicKey },
  });

  // ── 2. register the privacy intent server-side ───────────────────────
  onStep({ step: "prepare", status: "active", message: "Preparing private deposit…" });
  let prepared: PreparePrivateResponse;
  try {
    prepared = await apiPost<PreparePrivateResponse>("/deposits/prepare-private", {
      poolAddress: input.poolAddress,
      stealthPubkey: stealth.publicKey,
      amountUsd: input.amountUsd,
      shape: input.shape,
      range: { lower: input.lowerBinId, upper: input.upperBinId },
      allocation: input.allocation,
    });
  } catch (err) {
    onStep({ step: "prepare", status: "error", message: describe(err) });
    throw err;
  }
  onStep({
    step: "prepare",
    status: "ok",
    data: { positionId: prepared.positionId, receiptId: prepared.receipt.receiptId },
  });

  // ── 3. load on-chain pool state + bin arrays ─────────────────────────
  onStep({ step: "use-pool", status: "active", message: "Loading pool state…" });
  let config: TestPairConfig;
  try {
    config = await apiPost<TestPairConfig>("/executor/use-pool", {
      lbPair: input.poolAddress,
      width,
      lowerBinId: input.lowerBinId,
    });
  } catch (err) {
    onStep({ step: "use-pool", status: "error", message: describe(err) });
    throw err;
  }
  onStep({ step: "use-pool", status: "ok", data: { lbPair: config.lbPair } });

  // ── 4. init the executor's PA-owned DLMM position (silent stealth sign) ──
  onStep({ step: "init-position", status: "active", message: "Opening private position…" });
  let initSig: string;
  let initResp: InitPositionResponse;
  try {
    initResp = await apiPost<InitPositionResponse>("/executor/init-position-tx", {
      stealth: stealth.publicKey,
      lbPair: config.lbPair,
      exitRecipient: input.mainWalletAddress,
      lowerBinId: config.lowerBinId,
      width: config.width,
    });
    const tx = decodeBase64Tx(initResp.transaction);
    tx.partialSign(stealth.keypair);
    initSig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await waitForConfirmation(connection, initSig, tx.recentBlockhash!);
  } catch (err) {
    onStep({ step: "init-position", status: "error", message: describe(err) });
    throw err;
  }
  onStep({
    step: "init-position",
    status: "ok",
    data: { positionPubkey: initResp.positionPubkey, signature: initSig },
  });

  // ── 5. fund + add liquidity (the only on-chain user signature) ───────
  onStep({
    step: "fund-position",
    status: "active",
    message: "Confirm in your wallet to fund the position…",
  });
  let fundSig: string;
  try {
    const { transaction } = await apiPost<AddLiquidityResponse>("/executor/add-liquidity-tx", {
      stealth: stealth.publicKey,
      userOwner: input.mainWalletAddress,
      config,
      amountX: input.amountX.toString(),
      amountY: input.amountY.toString(),
    });
    const tx = decodeBase64Tx(transaction);
    // Stealth signs first while the keypair is in browser memory; only then
    // do we hand off to the wallet adapter for the user signature.
    tx.partialSign(stealth.keypair);

    const signer = getInjectedSigner();
    const signed = await signer.signTransaction(tx);

    fundSig = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await waitForConfirmation(connection, fundSig, signed.recentBlockhash!);
  } catch (err) {
    onStep({ step: "fund-position", status: "error", message: describe(err) });
    throw err;
  }
  onStep({ step: "fund-position", status: "ok", data: { signature: fundSig } });

  const result: PrivateDepositResult = {
    positionId: prepared.positionId,
    stealthPubkey: stealth.publicKey,
    positionPubkey: initResp.positionPubkey,
    initSignature: initSig,
    fundSignature: fundSig,
  };
  onStep({ step: "done", status: "ok", data: result as unknown as Record<string, unknown> });
  return result;
}

/**
 * Confirm a transaction without re-fetching `lastValidBlockHeight`. The server
 * pre-signs against its own blockhash, so we trust that value rather than
 * the freshest one to avoid block-height-mismatch confirmation strategies.
 */
async function waitForConfirmation(
  connection: Connection,
  signature: string,
  blockhash: string,
): Promise<void> {
  const { lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? cause.message : undefined;
    return [err.message, causeMsg].filter(Boolean).join(" / ");
  }
  return String(err);
}
