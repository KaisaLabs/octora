import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { deriveStealthForPool, type DerivedStealth } from "./stealthVault";

// `@/lib/mixer` transitively imports circomlibjs and the snarkjs/witness
// machinery (~3MB). Loading it at module level here would pull that whole
// bundle into every page that mounts PrivateDepositModal, blanking the
// entire app while it parses. Dynamic-import inside `runPrivateDeposit`
// instead so the cost is paid once, only when a user actually deposits.
type MixerModule = typeof import("./mixer");
let mixerModulePromise: Promise<MixerModule> | null = null;
function loadMixer(): Promise<MixerModule> {
  mixerModulePromise ??= import("./mixer");
  return mixerModulePromise;
}

/**
 * Private deposit orchestrator (single-sided SOL, fixed denomination).
 *
 * 1. derive          — sign deterministic message → derive stealth keypair (1 popup, free)
 * 2. relayer-info    — fetch relayer pubkey, fee, and pool denomination
 * 3. prepare         — POST /deposits/prepare-private (registers privacy intent)
 * 4. mixer-deposit   — generate commitment, main wallet signs+submits mixer.deposit
 * 5. confirm-deposit — record leaf index server-side so the public history stays warm
 * 6. build-tree      — reconstruct the Merkle tree locally from /mixer/deposits
 * 7. prove           — Groth16 prove in-browser (witness never leaves the device)
 * 8. relayer-withdraw — POST /relayer/withdraw, relayer submits and funds the stealth
 * 9. use-pool        — load on-chain DLMM state for the chosen pool
 * 10. init-position  — stealth signs init position (silent; no popup)
 * 11. add-liquidity  — stealth signs add liquidity (silent; no main-wallet co-sign)
 *
 * Only step 1 and step 4 trigger a wallet popup; everything else is signed
 * by the stealth keypair locally or by the relayer hot wallet server-side.
 */

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";
const RPC_URL =
  (import.meta.env.VITE_RPC_URL as string | undefined) ?? "https://api.devnet.solana.com";

export type DepositStepKey =
  | "derive"
  | "relayer-info"
  | "prepare"
  | "mixer-deposit"
  | "confirm-deposit"
  | "build-tree"
  | "prove"
  | "relayer-withdraw"
  | "use-pool"
  | "init-position"
  | "add-liquidity"
  | "done";

export interface DepositStepEvent {
  step: DepositStepKey;
  status: "active" | "ok" | "error";
  message?: string;
  data?: Record<string, unknown>;
}

export type DepositStepCallback = (event: DepositStepEvent) => void;

export type DistributionShape = "spot" | "curve" | "bid-ask";

export interface PrivateDepositInput {
  mainWalletAddress: string;
  poolAddress: string;
  lowerBinId: number;
  upperBinId: number;
  shape: DistributionShape;
  /**
   * Selected mixer pool denomination in lamports (base-10 string). When
   * omitted, the orchestrator uses whichever denomination the server
   * advertises as the default in `/relayer/info`.
   */
  denominationLamports?: string;
}

export interface PrivateDepositResult {
  positionId: string;
  stealthPubkey: string;
  positionPubkey: string;
  mixerDepositSignature: string;
  relayerWithdrawSignature: string;
  initSignature: string;
  fundSignature: string;
  /** Lamports landed on the stealth wallet (denomination − relayer fee). */
  fundedLamports: string;
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
  /** Default-pool denomination — kept for legacy single-pool clients. */
  denominationLamports: string;
  /** Default-pool mixer PDA. */
  mixerPoolAddress: string;
  /** Multi-pool list — newer clients pick the entry matching the user's choice. */
  pools?: Array<{ denomination: string; mixerPoolAddress: string }>;
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
  transaction: string | null;
  positionPubkey: string;
  positionAuthority: string;
  alreadyInitialized: boolean;
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
  const {
    buildWithdrawCircuitInput,
    createMixerMerkleTree,
    generateCommitment,
    generateWithdrawProof,
    pubkeyToFieldHash,
  } = await loadMixer();

  // ── 1. derive stealth ─────────────────────────────────────────────
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
  onStep({ step: "derive", status: "ok", data: { stealthPubkey: stealth.publicKey } });

  // ── 2. fetch relayer binding info ─────────────────────────────────
  onStep({ step: "relayer-info", status: "active", message: "Fetching mixer config…" });
  let relayerInfo: RelayerInfo;
  try {
    relayerInfo = await apiGet<RelayerInfo>("/relayer/info");
  } catch (err) {
    onStep({ step: "relayer-info", status: "error", message: describe(err) });
    throw err;
  }

  // Resolve which denomination this run targets. When the caller asked for a
  // specific pool, look it up in the multi-pool list; otherwise fall back to
  // the server's default. The denomination is plumbed into every subsequent
  // /mixer and /relayer call so the registry dispatches to the right pool.
  let denomination: bigint;
  if (input.denominationLamports !== undefined) {
    const requested = BigInt(input.denominationLamports);
    const matched = relayerInfo.pools?.find(
      (p) => BigInt(p.denomination) === requested,
    );
    if (!matched) {
      const err = new Error(
        `Requested denomination ${requested} not advertised by /relayer/info.`,
      );
      onStep({ step: "relayer-info", status: "error", message: err.message });
      throw err;
    }
    denomination = requested;
  } else {
    denomination = BigInt(relayerInfo.denominationLamports);
  }
  const denominationParam = denomination.toString();
  const fee = BigInt(relayerInfo.feeLamports);
  onStep({
    step: "relayer-info",
    status: "ok",
    data: { denominationLamports: denomination.toString(), feeLamports: fee.toString() },
  });

  // ── 3. register the privacy intent ────────────────────────────────
  onStep({ step: "prepare", status: "active", message: "Preparing private deposit…" });
  let prepared: PreparePrivateResponse;
  try {
    prepared = await apiPost<PreparePrivateResponse>("/deposits/prepare-private", {
      poolAddress: input.poolAddress,
      stealthPubkey: stealth.publicKey,
      shape: input.shape,
      range: { lower: input.lowerBinId, upper: input.upperBinId },
      denominationLamports: denominationParam,
    });
  } catch (err) {
    onStep({ step: "prepare", status: "error", message: describe(err) });
    throw err;
  }
  onStep({ step: "prepare", status: "ok", data: { positionId: prepared.positionId } });

  // ── 4. mixer.deposit (main wallet signs the commitment) ───────────
  onStep({
    step: "mixer-deposit",
    status: "active",
    message: `Confirm in your wallet to deposit ${formatSol(denomination)} into the mixer…`,
  });
  let commitmentBundle;
  let mixerDepositSig: string;
  let leafIndex: number;
  try {
    commitmentBundle = await generateCommitment();

    // Capture the leaf index BEFORE depositing so we know where our commitment
    // will land when the on-chain handler increments next_leaf_index. The mixer
    // pool serializes commitments through `next_leaf_index` so this read-then-
    // submit pattern is race-free as long as we don't have multiple concurrent
    // deposits from the same browser tab.
    const preStatus = await apiGet<MixerStatus>(
      `/mixer/status?denomination=${denominationParam}`,
    );
    leafIndex = preStatus.nextLeafIndex;

    const { transaction: depositB64 } = await apiPost<MixerDepositTxResp>("/mixer/deposit", {
      depositor: input.mainWalletAddress,
      commitment: commitmentBundle.commitment.toString(),
      denomination: denominationParam,
    });
    const depositTx = decodeBase64Tx(depositB64);
    const signed = await getInjectedSigner().signTransaction(depositTx);
    mixerDepositSig = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await waitForConfirmation(connection, mixerDepositSig, signed.recentBlockhash!);
  } catch (err) {
    onStep({ step: "mixer-deposit", status: "error", message: describe(err) });
    throw err;
  }
  onStep({
    step: "mixer-deposit",
    status: "ok",
    data: { signature: mixerDepositSig, leafIndex },
  });

  // ── 5. confirm-deposit (warm the server's history cache) ──────────
  onStep({ step: "confirm-deposit", status: "active", message: "Recording deposit…" });
  try {
    await apiPost("/mixer/confirm-deposit", {
      commitment: commitmentBundle.commitment.toString(),
      leafIndex,
      txSignature: mixerDepositSig,
      denomination: denominationParam,
    });
  } catch (err) {
    // Best-effort — the server can still rehydrate from chain logs.
    onStep({ step: "confirm-deposit", status: "error", message: describe(err) });
  }
  onStep({ step: "confirm-deposit", status: "ok" });

  // ── 6. build merkle tree locally ──────────────────────────────────
  onStep({ step: "build-tree", status: "active", message: "Reconstructing Merkle tree…" });
  let tree;
  try {
    const list = await apiGet<MixerDepositList>(
      `/mixer/deposits?denomination=${denominationParam}`,
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

  // ── 7. generate Groth16 proof ─────────────────────────────────────
  onStep({
    step: "prove",
    status: "active",
    message: "Generating zero-knowledge proof (10–60s)…",
  });
  let proof;
  let publicSignals: string[];
  try {
    const stealthPubkey = new PublicKey(stealth.publicKey);
    const relayerPubkey = new PublicKey(relayerInfo.relayerPubkey);
    const recipientField = await pubkeyToFieldHash(stealthPubkey);
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

  // ── 8. relayer.withdraw → stealth gets funded ─────────────────────
  onStep({
    step: "relayer-withdraw",
    status: "active",
    message: "Submitting withdrawal to relayer…",
  });
  let relayerSig: string;
  let fundedLamports: string;
  try {
    const result = await apiPost<RelayerWithdrawResp>("/relayer/withdraw", {
      proof,
      publicSignals,
      root: tree.root().toString(),
      nullifierHash: commitmentBundle.nullifierHash.toString(),
      recipient: stealth.publicKey,
      fee: fee.toString(),
      denomination: denominationParam,
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

  // ── 9. use-pool ───────────────────────────────────────────────────
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

  // ── 10. init-position (silent stealth sign) ───────────────────────
  onStep({ step: "init-position", status: "active", message: "Opening private position…" });
  let initSig: string | null = null;
  let initResp: InitPositionResponse;
  try {
    initResp = await apiPost<InitPositionResponse>("/executor/init-position-tx", {
      stealth: stealth.publicKey,
      lbPair: config.lbPair,
      // Exit recipient = stealth itself so the rent + dust come back to it on
      // close. Real claim/withdraw flows route the actual position outputs
      // through a separately derived "yield address".
      exitRecipient: stealth.publicKey,
      lowerBinId: config.lowerBinId,
      width: config.width,
    });
    if (initResp.alreadyInitialized || initResp.transaction === null) {
      // Position already exists for this (stealth, pool) pair — typically
      // because a prior run created it before failing further down. Skip the
      // on-chain init and reuse the existing position for add_liquidity.
    } else {
      const tx = decodeBase64Tx(initResp.transaction);
      tx.partialSign(stealth.keypair);
      initSig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await waitForConfirmation(connection, initSig, tx.recentBlockhash!);
    }
  } catch (err) {
    onStep({ step: "init-position", status: "error", message: describe(err) });
    throw err;
  }
  onStep({
    step: "init-position",
    status: "ok",
    data: {
      positionPubkey: initResp.positionPubkey,
      signature: initSig,
      reused: initResp.alreadyInitialized,
    },
  });

  // ── 11. add-liquidity (stealth-only signature) ────────────────────
  onStep({ step: "add-liquidity", status: "active", message: "Adding single-sided SOL…" });
  let fundSig: string;
  try {
    // The relayer keeps a few lamports back as headroom for rent on the
    // stealth WSOL ATA + the close-account refund cycle. We pass the full
    // funded amount minus a small reserve so the wrap doesn't underflow
    // on the SystemProgram.transfer.
    const reserve = 5_000_000n;
    const totalSolLamports = BigInt(fundedLamports) - reserve;
    if (totalSolLamports <= 0n) {
      throw new Error(
        `Funded amount ${fundedLamports} too small after rent reserve (${reserve}).`,
      );
    }

    const { transaction } = await apiPost<AddLiquidityResponse>("/executor/add-liquidity-tx", {
      stealth: stealth.publicKey,
      config,
      totalSolLamports: totalSolLamports.toString(),
      shape: input.shape,
    });
    const tx = decodeBase64Tx(transaction);
    tx.partialSign(stealth.keypair);
    fundSig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await waitForConfirmation(connection, fundSig, tx.recentBlockhash!);
  } catch (err) {
    onStep({ step: "add-liquidity", status: "error", message: describe(err) });
    throw err;
  }
  onStep({ step: "add-liquidity", status: "ok", data: { signature: fundSig } });

  const result: PrivateDepositResult = {
    positionId: prepared.positionId,
    stealthPubkey: stealth.publicKey,
    positionPubkey: initResp.positionPubkey,
    mixerDepositSignature: mixerDepositSig,
    relayerWithdrawSignature: relayerSig,
    initSignature: initSig,
    fundSignature: fundSig,
    fundedLamports,
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

function formatSol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const frac = lamports % 1_000_000_000n;
  if (frac === 0n) return `${whole} SOL`;
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}.${fracStr} SOL`;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? cause.message : undefined;
    return [err.message, causeMsg].filter(Boolean).join(" / ");
  }
  return String(err);
}
