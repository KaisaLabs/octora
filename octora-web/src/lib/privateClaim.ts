import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { deriveStealthForPool, type DerivedStealth } from "./stealthVault";
import { breadcrumb } from "./observability";

type MixerModule = typeof import("./mixer");
let mixerModulePromise: Promise<MixerModule> | null = null;
function loadMixer(): Promise<MixerModule> {
  mixerModulePromise ??= import("./mixer");
  return mixerModulePromise;
}

/**
 * Private claim-fees orchestrator (LP position stays open; fees → main wallet).
 *
 *  1. derive            — sign deterministic message → stealth keypair (1 popup)
 *  2. relayer-info      — fetch relayer pubkey, fee, available pools
 *  3. position-state    — read accrued fees per side
 *  4. claim             — dlmm_claim_fees (stealth signs); fees land at stealth ATAs
 *  5. swap              — if non-SOL fee leg has balance, swap it to SOL on the LP pool
 *  6. threshold-check   — total claimed SOL must be ≥ smallest configured mixer denom,
 *                         else abort and let fees keep accruing (no mixer fee burn)
 *  7. pick-denomination — largest denom ≤ stealth's free SOL
 *  8. mixer-deposit     — generate commitment, stealth signs
 *  9. confirm-deposit   — warm server cache
 *  10. build-tree       — local Merkle reconstruction
 *  11. prove            — Groth16 in-browser
 *  12. relayer-withdraw — relayer broadcasts to main wallet
 *
 * The position remains `active` afterwards — only the fees are extracted.
 * The user can claim privately again on the next accrual cycle.
 */

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";
const RPC_URL =
  (import.meta.env.VITE_RPC_URL as string | undefined) ?? "https://api.devnet.solana.com";

const NATIVE_MINT = "So11111111111111111111111111111111111111112";
const STEALTH_RESERVE_LAMPORTS = 5_000_000n;
const DEFAULT_SLIPPAGE_BPS = 500; // 5 %

export type ClaimStepKey =
  | "derive"
  | "relayer-info"
  | "position-state"
  | "claim"
  | "swap"
  | "threshold-check"
  | "pick-denomination"
  | "mixer-deposit"
  | "confirm-deposit"
  | "build-tree"
  | "prove"
  | "relayer-withdraw"
  | "done";

export interface ClaimStepEvent {
  step: ClaimStepKey;
  status: "active" | "ok" | "error";
  message?: string;
  data?: Record<string, unknown>;
}

export type ClaimStepCallback = (event: ClaimStepEvent) => void;

export interface PrivateClaimInput {
  mainWalletAddress: string;
  poolAddress: string;
  slippageBps?: number;
}

export interface PrivateClaimResult {
  claimSignature: string;
  swapSignature: string | null;
  mixerDepositSignature: string;
  relayerWithdrawSignature: string;
  fundedLamports: string;
  residueLamports: string;
  selectedDenominationLamports: string;
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

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

function decodeBase64Tx(base64: string): Transaction {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return Transaction.from(bytes);
}

interface RelayerInfo {
  relayerPubkey: string;
  feeLamports: string;
  denominationLamports: string;
  mixerPoolAddress: string;
  pools?: Array<{ denomination: string; mixerPoolAddress: string }>;
}

interface PoolAuthorityInfo {
  exitRecipient: string;
  positionPubkey: string;
}

interface PositionStateView {
  positionPubkey: string;
  lbPair: string;
  tokenXMint: string;
  tokenYMint: string;
  decimalsX: number;
  decimalsY: number;
  feeXLamports: string;
  feeYLamports: string;
  lowerBinId: number;
  upperBinId: number;
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

interface BuildSwapTxResp {
  transaction: string;
  userTokenIn: string;
  userTokenOut: string;
}

interface SwapQuoteResp {
  amountIn: string;
  expectedOut: string;
  minOut: string;
  allowedSlippageBps: number;
  consumedIn: string;
  feeLamports: string;
  priceImpact: string;
  endPrice: string;
  swapForY: boolean;
}

interface MixerStatus {
  poolAddress: string;
  denomination: string;
  nextLeafIndex: number;
  isPaused: boolean;
  balance: string;
  depositsTracked: number;
}

interface MixerDepositList {
  deposits: Array<{ commitment: string; leafIndex: number; txSignature: string }>;
}

interface MixerDepositTxResp {
  transaction: string;
}

interface RelayerWithdrawResp {
  success: boolean;
  txSignature: string | null;
  recipient: string;
  amountLamports: string;
  feeLamports: string;
  error?: string;
}

export async function runPrivateClaim(
  input: PrivateClaimInput,
  onStepRaw: ClaimStepCallback = () => {},
): Promise<PrivateClaimResult> {
  const onStep: ClaimStepCallback = (event) => {
    breadcrumb(
      "privateClaim",
      `${event.step}:${event.status}`,
      event.data,
      event.status === "error" ? "error" : "info",
    );
    onStepRaw(event);
  };

  const connection = new Connection(RPC_URL, "confirmed");
  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const {
    buildWithdrawCircuitInput,
    createMixerMerkleTree,
    generateCommitment,
    generateWithdrawProof,
    pubkeyToFieldHash,
  } = await loadMixer();

  // ── 1. derive stealth ─────────────────────────────────────────────
  onStep({ step: "derive", status: "active", message: "Authorize private claim in your wallet…" });
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
  onStep({ step: "derive", status: "ok", data: { stealthPubkey: stealth.publicKey } });

  // ── 2. relayer info ──────────────────────────────────────────────
  onStep({ step: "relayer-info", status: "active", message: "Fetching mixer config…" });
  let relayerInfo: RelayerInfo;
  try {
    relayerInfo = await apiGet<RelayerInfo>("/relayer/info");
  } catch (err) {
    onStep({ step: "relayer-info", status: "error", message: describe(err) });
    throw err;
  }
  const fee = BigInt(relayerInfo.feeLamports);
  const availableDenoms = (relayerInfo.pools ?? [
    { denomination: relayerInfo.denominationLamports, mixerPoolAddress: relayerInfo.mixerPoolAddress },
  ])
    .map((p) => BigInt(p.denomination))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const smallestDenom = availableDenoms[availableDenoms.length - 1];
  if (availableDenoms.length === 0) {
    const err = new Error("No mixer pools advertised by /relayer/info");
    onStep({ step: "relayer-info", status: "error", message: err.message });
    throw err;
  }
  onStep({ step: "relayer-info", status: "ok" });

  // ── 3. position state — read accrued fees ───────────────────────
  onStep({ step: "position-state", status: "active", message: "Reading accrued fees…" });
  let position: PositionStateView;
  let usePoolConfig: TestPairConfig;
  try {
    const poolAuthority = await apiGet<PoolAuthorityInfo>(
      `/executor/pool-authority?stealth=${stealth.publicKey}&lbPair=${input.poolAddress}`,
    );
    position = await apiGet<PositionStateView>(
      `/executor/position-state?lbPair=${input.poolAddress}&positionPubkey=${poolAuthority.positionPubkey}`,
    );
    if (poolAuthority.exitRecipient !== stealth.publicKey) {
      throw new Error(
        `exit_recipient is ${poolAuthority.exitRecipient}, expected ${stealth.publicKey}. ` +
          "Refusing — private claim requires exit_recipient = stealth.",
      );
    }
    usePoolConfig = await apiPost<TestPairConfig>("/executor/use-pool", {
      lbPair: input.poolAddress,
      width: position.upperBinId - position.lowerBinId + 1,
      lowerBinId: position.lowerBinId,
    });
  } catch (err) {
    onStep({ step: "position-state", status: "error", message: describe(err) });
    throw err;
  }
  onStep({ step: "position-state", status: "ok" });

  // ── 4. dlmm_claim_fees — fees land at stealth ATAs ───────────────
  onStep({ step: "claim", status: "active", message: "Claiming fees…" });
  let claimSig: string;
  try {
    const { transaction } = await apiPost<{ transaction: string }>("/executor/claim-fees-tx", {
      stealth: stealth.publicKey,
      config: usePoolConfig,
    });
    const tx = decodeBase64Tx(transaction);
    tx.partialSign(stealth.keypair);
    claimSig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await waitForConfirmation(connection, claimSig, tx.recentBlockhash!);
  } catch (err) {
    onStep({ step: "claim", status: "error", message: describe(err) });
    throw err;
  }
  onStep({ step: "claim", status: "ok", data: { signature: claimSig } });

  // ── 5. swap non-SOL fees to SOL on the LP pool (same-pool fallback) ─
  onStep({ step: "swap", status: "active", message: "Consolidating fees to SOL…" });
  let swapSig: string | null = null;
  try {
    const xIsSol = position.tokenXMint === NATIVE_MINT;
    const yIsSol = position.tokenYMint === NATIVE_MINT;
    if (!xIsSol && !yIsSol) {
      throw new Error(
        "Position is not SOL-paired. MVP only supports SOL-paired pools.",
      );
    }
    const nonSolFee = BigInt(xIsSol ? position.feeYLamports : position.feeXLamports);
    if (nonSolFee > 0n) {
      const swapForY = !xIsSol;
      // Real on-chain quote — see privateExit.ts swap step for why a 1:1
      // placeholder minOut is broken for meme tokens.
      const quote = await apiGet<SwapQuoteResp>(
        `/dlmm/pools/${input.poolAddress}/swap-quote` +
          `?amountIn=${nonSolFee.toString()}` +
          `&swapForY=${swapForY}` +
          `&allowedSlippageBps=${slippageBps}`,
      );
      const minOut = BigInt(quote.minOut);
      const { transaction } = await apiPost<BuildSwapTxResp>("/executor/dlmm-swap-tx", {
        stealth: stealth.publicKey,
        lbPair: input.poolAddress,
        amountIn: nonSolFee.toString(),
        minAmountOut: minOut.toString(),
        swapForY,
      });
      const tx = decodeBase64Tx(transaction);
      tx.partialSign(stealth.keypair);
      swapSig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await waitForConfirmation(connection, swapSig, tx.recentBlockhash!);
    }
  } catch (err) {
    onStep({ step: "swap", status: "error", message: describe(err) });
    throw err;
  }
  onStep({ step: "swap", status: "ok", data: { signature: swapSig } });

  // ── 6. minimum-claim threshold: don't burn mixer fees on dust ────
  onStep({ step: "threshold-check", status: "active", message: "Checking claim size…" });
  let stealthBalanceLamports: bigint;
  try {
    stealthBalanceLamports = BigInt(
      await connection.getBalance(new PublicKey(stealth.publicKey)),
    );
    const available = stealthBalanceLamports - STEALTH_RESERVE_LAMPORTS;
    if (available < smallestDenom) {
      throw new Error(
        `Claim too small: ${available} lamports below the smallest mixer pool ` +
          `(${smallestDenom}). Let fees accrue and try again.`,
      );
    }
  } catch (err) {
    onStep({ step: "threshold-check", status: "error", message: describe(err) });
    throw err;
  }
  onStep({ step: "threshold-check", status: "ok" });

  // ── 7. pick largest denomination that fits ──────────────────────
  onStep({ step: "pick-denomination", status: "active", message: "Selecting mixer pool…" });
  let chosenDenom: bigint;
  let residueLamports: bigint;
  try {
    const available = stealthBalanceLamports - STEALTH_RESERVE_LAMPORTS;
    chosenDenom = availableDenoms.find((d) => d <= available)!;
    residueLamports = stealthBalanceLamports - chosenDenom;
  } catch (err) {
    onStep({ step: "pick-denomination", status: "error", message: describe(err) });
    throw err;
  }
  onStep({
    step: "pick-denomination",
    status: "ok",
    data: {
      denominationLamports: chosenDenom.toString(),
      residueLamports: residueLamports.toString(),
    },
  });

  // ── 8. mixer deposit ────────────────────────────────────────────
  onStep({ step: "mixer-deposit", status: "active", message: "Depositing fees into mixer…" });
  let commitmentBundle;
  let mixerDepositSig: string;
  let leafIndex: number;
  try {
    commitmentBundle = await generateCommitment();
    const denomParam = chosenDenom.toString();

    const preStatus = await apiGet<MixerStatus>(
      `/mixer/status?denomination=${denomParam}`,
    );
    leafIndex = preStatus.nextLeafIndex;

    const { transaction: depositB64 } = await apiPost<MixerDepositTxResp>("/mixer/deposit", {
      depositor: stealth.publicKey,
      commitment: commitmentBundle.commitment.toString(),
      denomination: denomParam,
    });
    const tx = decodeBase64Tx(depositB64);
    tx.partialSign(stealth.keypair);
    mixerDepositSig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await waitForConfirmation(connection, mixerDepositSig, tx.recentBlockhash!);
  } catch (err) {
    onStep({ step: "mixer-deposit", status: "error", message: describe(err) });
    throw err;
  }
  onStep({
    step: "mixer-deposit",
    status: "ok",
    data: { signature: mixerDepositSig, leafIndex },
  });

  // ── 9. confirm-deposit ───────────────────────────────────────────
  onStep({ step: "confirm-deposit", status: "active", message: "Recording deposit…" });
  try {
    await apiPost("/mixer/confirm-deposit", {
      commitment: commitmentBundle.commitment.toString(),
      leafIndex,
      txSignature: mixerDepositSig,
      denomination: chosenDenom.toString(),
    });
  } catch (err) {
    onStep({ step: "confirm-deposit", status: "error", message: describe(err) });
  }
  onStep({ step: "confirm-deposit", status: "ok" });

  // ── 10. build Merkle tree locally ───────────────────────────────
  onStep({ step: "build-tree", status: "active", message: "Reconstructing Merkle tree…" });
  let tree;
  try {
    const list = await apiGet<MixerDepositList>(
      `/mixer/deposits?denomination=${chosenDenom.toString()}`,
    );
    const ordered = [...list.deposits].sort((a, b) => a.leafIndex - b.leafIndex);
    const leaves = ordered.map((d) => BigInt(d.commitment));
    tree = await createMixerMerkleTree(undefined, leaves);
    if (tree.indexOf(commitmentBundle.commitment) === -1) {
      throw new Error("Commitment not found in tree — server cache may be stale.");
    }
  } catch (err) {
    onStep({ step: "build-tree", status: "error", message: describe(err) });
    throw err;
  }
  onStep({ step: "build-tree", status: "ok" });

  // ── 11. Groth16 proof (recipient = main wallet) ────────────────
  onStep({
    step: "prove",
    status: "active",
    message: "Generating zero-knowledge proof (10–60s)…",
  });
  let proof;
  let publicSignals: string[];
  try {
    const recipientPubkey = new PublicKey(input.mainWalletAddress);
    const relayerPubkey = new PublicKey(relayerInfo.relayerPubkey);
    const recipientField = await pubkeyToFieldHash(recipientPubkey);
    const relayerField = await pubkeyToFieldHash(relayerPubkey);

    const localLeafIndex = tree.indexOf(commitmentBundle.commitment);
    const circuitInput = buildWithdrawCircuitInput({
      tree,
      leafIndex: localLeafIndex,
      secret: commitmentBundle.secret,
      nullifier: commitmentBundle.nullifier,
      nullifierHash: commitmentBundle.nullifierHash,
      recipientField,
      relayerField,
      fee,
    });
    const proofResult = await generateWithdrawProof(circuitInput);
    proof = proofResult.proof;
    publicSignals = proofResult.publicSignals;
  } catch (err) {
    onStep({ step: "prove", status: "error", message: describe(err) });
    throw err;
  }
  onStep({ step: "prove", status: "ok" });

  // ── 12. relayer withdraw → main wallet ──────────────────────────
  onStep({
    step: "relayer-withdraw",
    status: "active",
    message: "Relayer broadcasting to main wallet…",
  });
  let relayerSig: string;
  let fundedLamports: string;
  try {
    const result = await apiPost<RelayerWithdrawResp>("/relayer/withdraw", {
      proof,
      publicSignals,
      root: tree.root().toString(),
      nullifierHash: commitmentBundle.nullifierHash.toString(),
      recipient: input.mainWalletAddress,
      fee: fee.toString(),
      denomination: chosenDenom.toString(),
    });
    if (!result.success || !result.txSignature) {
      throw new Error(result.error ?? "relayer.withdraw failed");
    }
    relayerSig = result.txSignature;
    fundedLamports = result.amountLamports;
  } catch (err) {
    onStep({ step: "relayer-withdraw", status: "error", message: describe(err) });
    throw err;
  }
  onStep({
    step: "relayer-withdraw",
    status: "ok",
    data: { signature: relayerSig, fundedLamports },
  });

  const result: PrivateClaimResult = {
    claimSignature: claimSig,
    swapSignature: swapSig,
    mixerDepositSignature: mixerDepositSig,
    relayerWithdrawSignature: relayerSig,
    fundedLamports,
    residueLamports: residueLamports.toString(),
    selectedDenominationLamports: chosenDenom.toString(),
  };
  onStep({ step: "done", status: "ok", data: result as unknown as Record<string, unknown> });
  return result;
}

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

void getInjectedSigner;
