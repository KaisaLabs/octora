import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { deriveStealthForPool, type DerivedStealth } from "./stealthVault";
import { breadcrumb } from "./observability";

// Dynamic-import the mixer module the same way privateDeposit does so the
// ~3MB snarkjs/circomlibjs bundle is paid only on the first private-exit
// rather than at every page mount.
type MixerModule = typeof import("./mixer");
let mixerModulePromise: Promise<MixerModule> | null = null;
function loadMixer(): Promise<MixerModule> {
  mixerModulePromise ??= import("./mixer");
  return mixerModulePromise;
}

/**
 * Private exit orchestrator (single-sided SOL position → main wallet).
 *
 *  1. derive            — sign deterministic message → stealth keypair (1 popup)
 *  2. relayer-info      — fetch relayer pubkey, fee, available pools
 *  3. position-state    — read current position so we know which tokens land at stealth
 *  4. close             — dlmm_withdraw_close (stealth signs); proceeds go to stealth ATAs
 *  5. swap              — if non-SOL leg has balance, swap it to SOL on the LP pool
 *                         (same-pool fallback — see plan §0; bound by min_amount_out)
 *  6. pick-denomination — choose the largest mixer denom ≤ stealth's free SOL balance;
 *                         residue stays at stealth for later sweep
 *  7. mixer-deposit     — generate commitment, stealth signs the deposit tx
 *  8. confirm-deposit   — warm the server's deposit history cache
 *  9. build-tree        — reconstruct Merkle tree locally
 *  10. prove            — Groth16 in-browser proof (witness never leaves device)
 *  11. relayer-withdraw — POST /relayer/withdraw; relayer broadcasts to main wallet
 *
 * Only step 1 triggers a wallet popup. The stealth keypair signs every
 * subsequent transaction silently; the relayer pays gas for step 11 and
 * the main wallet's only proof of existence is being the proof's
 * `recipient` public input (never linked to the stealth on-chain).
 */

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";
const RPC_URL =
  (import.meta.env.VITE_RPC_URL as string | undefined) ?? "https://api.devnet.solana.com";

const NATIVE_MINT = "So11111111111111111111111111111111111111112";
// Buffer left on the stealth wallet after the mixer deposit so the close +
// swap cycle can still pay rent for any ATA the next operation creates.
// Same rationale as the deposit-side reserve in privateDeposit.ts.
const STEALTH_RESERVE_LAMPORTS = 5_000_000n;
// Default slippage cap on the swap-to-SOL leg. Matches MAX_SLIPPAGE_BPS in
// the server's swap.service for cross-layer consistency.
const DEFAULT_SLIPPAGE_BPS = 500; // 5 %

export type ExitStepKey =
  | "derive"
  | "relayer-info"
  | "position-state"
  | "close"
  | "swap"
  | "pick-denomination"
  | "mixer-deposit"
  | "confirm-deposit"
  | "build-tree"
  | "prove"
  | "relayer-withdraw"
  | "done";

export interface ExitStepEvent {
  step: ExitStepKey;
  status: "active" | "ok" | "error";
  message?: string;
  data?: Record<string, unknown>;
}

export type ExitStepCallback = (event: ExitStepEvent) => void;

export interface PrivateExitInput {
  /** Main wallet that opened the position originally (also receives the SOL). */
  mainWalletAddress: string;
  /** LP pool address (the lb_pair). */
  poolAddress: string;
  /** Override slippage on the swap-to-SOL leg in BPS (0–2000). Defaults to 500. */
  slippageBps?: number;
}

export interface PrivateExitResult {
  /** Withdraw-close on-chain signature. */
  closeSignature: string;
  /** Swap leg signature (null when the position closed to pure SOL). */
  swapSignature: string | null;
  /** Mixer deposit signature. */
  mixerDepositSignature: string;
  /** Relayer-broadcast withdraw signature — funds land on main wallet here. */
  relayerWithdrawSignature: string;
  /** Final lamports credited to the main wallet (denom − relayer fee). */
  fundedLamports: string;
  /** Lamports left at the stealth wallet (residue below smallest denom). */
  residueLamports: string;
  /** Denomination (lamports) chosen to route through the mixer. */
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
  pda: string;
  stealthPubkey: string;
  exitRecipient: string;
  lbPair: string;
  positionPubkey: string;
}

interface PositionStateView {
  positionPubkey: string;
  lbPair: string;
  lowerBinId: number;
  upperBinId: number;
  activeBinId: number;
  tokenXMint: string;
  tokenYMint: string;
  decimalsX: number;
  decimalsY: number;
  totalXLamports: string;
  totalYLamports: string;
  feeXLamports: string;
  feeYLamports: string;
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
  /** Lamports-out the swap is guaranteed to deliver post-slippage. Passed
   *  as the on-chain `min_amount_out` arg so the swap reverts cleanly if
   *  reality drifts further than `allowedSlippageBps` from the quote. */
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

export async function runPrivateExit(
  input: PrivateExitInput,
  onStepRaw: ExitStepCallback = () => {},
): Promise<PrivateExitResult> {
  // Mirror privateDeposit.ts — wrap onStep so every step transition
  // lands in Sentry breadcrumbs, scrubbed by the observability layer.
  const onStep: ExitStepCallback = (event) => {
    breadcrumb(
      "privateExit",
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
  onStep({ step: "derive", status: "active", message: "Authorize private exit in your wallet…" });
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

  // ── 2. relayer info — pick the pool that matches the exit value ─
  onStep({ step: "relayer-info", status: "active", message: "Fetching mixer config…" });
  let relayerInfo: RelayerInfo;
  try {
    relayerInfo = await apiGet<RelayerInfo>("/relayer/info");
  } catch (err) {
    onStep({ step: "relayer-info", status: "error", message: describe(err) });
    throw err;
  }
  const fee = BigInt(relayerInfo.feeLamports);
  // Sorted descending so step 6 ("pick largest denom that fits") can scan.
  const availableDenoms = (relayerInfo.pools ?? [
    { denomination: relayerInfo.denominationLamports, mixerPoolAddress: relayerInfo.mixerPoolAddress },
  ])
    .map((p) => BigInt(p.denomination))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  if (availableDenoms.length === 0) {
    const err = new Error("No mixer pools advertised by /relayer/info");
    onStep({ step: "relayer-info", status: "error", message: err.message });
    throw err;
  }
  onStep({
    step: "relayer-info",
    status: "ok",
    data: { feeLamports: fee.toString(), denominations: availableDenoms.map((d) => d.toString()) },
  });

  // ── 3. position state — read mints + balances so we know whether to swap ─
  onStep({ step: "position-state", status: "active", message: "Reading position…" });
  let position: PositionStateView;
  let poolAuthority: PoolAuthorityInfo;
  let usePoolConfig: TestPairConfig;
  try {
    // pool-authority gives us the on-chain positionPubkey and validates the
    // exit_recipient invariant in one shot — no need for the caller to
    // remember positionPubkey from the original deposit flow.
    poolAuthority = await apiGet<PoolAuthorityInfo>(
      `/executor/pool-authority?stealth=${stealth.publicKey}&lbPair=${input.poolAddress}`,
    );
    position = await apiGet<PositionStateView>(
      `/executor/position-state?lbPair=${input.poolAddress}&positionPubkey=${poolAuthority.positionPubkey}`,
    );
    // Privacy hard-stop: if exit_recipient drifted off-stealth (shouldn't be
    // possible since Day 1, but the on-chain PoolAuthority is the source
    // of truth) we refuse — sending fees to main directly would link them.
    if (poolAuthority.exitRecipient !== stealth.publicKey) {
      throw new Error(
        `exit_recipient is ${poolAuthority.exitRecipient}, expected ${stealth.publicKey}. ` +
          "Refusing — private exit requires exit_recipient = stealth.",
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
  onStep({ step: "position-state", status: "ok", data: { lbPair: usePoolConfig.lbPair } });

  // ── 4. dlmm_withdraw_close — proceeds land at stealth ATAs ────────
  onStep({ step: "close", status: "active", message: "Closing position…" });
  let closeSig: string;
  try {
    const { transaction } = await apiPost<{ transaction: string }>("/executor/withdraw-close-tx", {
      stealth: stealth.publicKey,
      config: usePoolConfig,
    });
    const tx = decodeBase64Tx(transaction);
    tx.partialSign(stealth.keypair);
    closeSig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await waitForConfirmation(connection, closeSig, tx.recentBlockhash!);
  } catch (err) {
    onStep({ step: "close", status: "error", message: describe(err) });
    throw err;
  }
  onStep({ step: "close", status: "ok", data: { signature: closeSig } });

  // ── 5. swap any non-SOL output to SOL via the same LP pool ───────
  // Single-sided SOL positions almost always close to a mix of SOL +
  // non-SOL token; the non-SOL side is whichever filled as price moved
  // through the bins. We swap that to SOL on the same lb_pair (per plan
  // §0, the same-pool fallback case). The slippage cap bounds the
  // self-front-run impact on this swap.
  onStep({ step: "swap", status: "active", message: "Consolidating to SOL…" });
  let swapSig: string | null = null;
  try {
    const xIsSol = position.tokenXMint === NATIVE_MINT;
    const yIsSol = position.tokenYMint === NATIVE_MINT;
    if (!xIsSol && !yIsSol) {
      throw new Error(
        "Position is not SOL-paired. MVP only supports SOL-paired pools — " +
          "non-SOL-quoted exits are post-MVP work.",
      );
    }
    // The non-SOL side balance is whatever the close moved out of bins +
    // accrued fees on that side. We swap the full non-SOL balance.
    const nonSolBalanceLamports = BigInt(xIsSol ? position.totalYLamports : position.totalXLamports);
    const nonSolFeeLamports = BigInt(xIsSol ? position.feeYLamports : position.feeXLamports);
    const totalNonSol = nonSolBalanceLamports + nonSolFeeLamports;

    if (totalNonSol > 0n) {
      // swapForY = direction; on a SOL-paired pool with non-SOL on X,
      // swapForY=false (selling X for Y=SOL). On non-SOL on Y, swapForY=true.
      const swapForY = !xIsSol; // tokenIn = non-SOL side

      // Real on-chain quote (Meteora SDK server-side). Crucial for meme
      // tokens — the previous 1:1 placeholder set `minOut` to ~95% of the
      // input meme-lamports, which is dramatically more than the swap can
      // actually produce in SOL-lamports, so every swap reverted on the
      // on-chain `min_amount_out` check.
      const quote = await apiGet<SwapQuoteResp>(
        `/dlmm/pools/${input.poolAddress}/swap-quote` +
          `?amountIn=${totalNonSol.toString()}` +
          `&swapForY=${swapForY}` +
          `&allowedSlippageBps=${slippageBps}`,
      );
      const minOut = BigInt(quote.minOut);

      const { transaction } = await apiPost<BuildSwapTxResp>("/executor/dlmm-swap-tx", {
        stealth: stealth.publicKey,
        lbPair: input.poolAddress,
        amountIn: totalNonSol.toString(),
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

  // ── 6. pick the largest denomination that fits in stealth's balance ─
  onStep({ step: "pick-denomination", status: "active", message: "Selecting mixer pool…" });
  let chosenDenom: bigint;
  let stealthBalanceLamports: bigint;
  let residueLamports: bigint;
  try {
    stealthBalanceLamports = BigInt(
      await connection.getBalance(new PublicKey(stealth.publicKey)),
    );
    const available = stealthBalanceLamports - STEALTH_RESERVE_LAMPORTS;
    if (available <= 0n) {
      throw new Error(
        `Stealth balance ${stealthBalanceLamports} below reserve ${STEALTH_RESERVE_LAMPORTS}. ` +
          "Close + swap may have failed.",
      );
    }
    const fits = availableDenoms.find((d) => d <= available);
    if (!fits) {
      throw new Error(
        `Stealth has ${available} lamports available — below smallest mixer denomination ` +
          `${availableDenoms[availableDenoms.length - 1]}. Try wait + claim, or sweep manually.`,
      );
    }
    chosenDenom = fits;
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

  // ── 7. mixer deposit ─────────────────────────────────────────────
  onStep({ step: "mixer-deposit", status: "active", message: "Depositing into mixer…" });
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

  // ── 8. confirm-deposit (best-effort cache warm) ──────────────────
  onStep({ step: "confirm-deposit", status: "active", message: "Recording deposit…" });
  try {
    await apiPost("/mixer/confirm-deposit", {
      commitment: commitmentBundle.commitment.toString(),
      leafIndex,
      txSignature: mixerDepositSig,
      denomination: chosenDenom.toString(),
    });
  } catch (err) {
    // Non-fatal: hydrateFromChain will pick this up on the next server scan.
    onStep({ step: "confirm-deposit", status: "error", message: describe(err) });
  }
  onStep({ step: "confirm-deposit", status: "ok" });

  // ── 9. build Merkle tree locally ─────────────────────────────────
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

  // ── 10. Groth16 proof (recipient = main wallet) ──────────────────
  // This is the privacy-breaking-or-keeping step. The proof binds the
  // recipient to the *main* wallet (not the stealth) so when the relayer
  // submits in the next step, anyone watching only sees `mixer → main`,
  // with no link back to the stealth that just deposited.
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

  // ── 11. relayer withdraw — main wallet credited ──────────────────
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

  const result: PrivateExitResult = {
    closeSignature: closeSig,
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

// Silence the lint-unused warning for the wallet-provider import — the
// fallback main-wallet signing path isn't used by exit (stealth signs
// everything except the initial derive). Keeping the import + helper here
// matches the privateDeposit.ts shape so the two orchestrators stay
// structurally identical for future maintenance.
void getInjectedSigner;
