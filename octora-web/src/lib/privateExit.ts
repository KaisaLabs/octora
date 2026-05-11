import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  deriveStealthForPool,
  deriveStealthForPosition,
  type DerivedStealth,
} from "./stealthVault";
import { executeStealthSweep } from "./privateLifecycle";
import { breadcrumb } from "./observability";
import { NETWORK } from "./api";

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
  | "dust-sweep"
  | "mixer-deposit"
  | "confirm-deposit"
  | "build-tree"
  | "prove"
  | "relayer-withdraw"
  | "done";

/**
 * "mixed" — full privacy round-trip through the mixer (default happy path).
 * "swept" — post-close balance was below the smallest mixer denomination, so
 *           the orchestrator skipped the mixer and signed a direct
 *           SystemProgram.transfer stealth → main. The on-chain link is
 *           visible; the user must have acknowledged this before close.
 */
export type ExitMode = "mixed" | "swept";

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
  /**
   * The position's UUID, persisted in localPositions at deposit time.
   * Drives v2 stealth derivation. When omitted (legacy v1 positions),
   * falls back to `deriveStealthForPool({wallet, pool})`.
   */
  positionId?: string;
  /** Override slippage on the swap-to-SOL leg in BPS (0–2000). Defaults to 500. */
  slippageBps?: number;
  /**
   * Explicit user opt-in to the non-private dust sweep fallback. When `false`
   * and the post-close balance is below the smallest mixer denomination the
   * orchestrator throws with the original "below smallest" error so the user
   * can decide. When `true` the orchestrator transparently sweeps stealth →
   * main (revealing the link) and returns `mode: "swept"`. The UI surfaces
   * this choice via the modal's pre-flight ack checkbox.
   */
  allowDustSweep?: boolean;
}

export interface PrivateExitResult {
  /** "mixed" (full privacy round-trip) or "swept" (dust fallback, link revealed). */
  mode: ExitMode;
  /** Withdraw-close on-chain signature. Null when this run re-entered a
   *  flow whose close already landed in a previous attempt (PoolAuthority
   *  was missing at start). */
  closeSignature: string | null;
  /** Swap leg signature. Null when the position closed to pure SOL, or
   *  when close was skipped as already-done. */
  swapSignature: string | null;
  /** Mixer deposit signature — present when mode === "mixed". */
  mixerDepositSignature: string | null;
  /** Relayer-broadcast withdraw signature — present when mode === "mixed". */
  relayerWithdrawSignature: string | null;
  /** Direct stealth → main transfer signature — present when mode === "swept". */
  sweepSignature: string | null;
  /** Final lamports credited to the main wallet. */
  fundedLamports: string;
  /** Lamports left at the stealth wallet (residue below smallest denom). */
  residueLamports: string;
  /** Denomination chosen to route through the mixer — null in swept mode. */
  selectedDenominationLamports: string | null;
}

/** Pre-flight estimate of recoverable SOL. Pure read — no signatures, no
 *  transactions. Used by the UI to warn the user before close when the
 *  result will fall below the smallest mixer denomination. */
export interface ExitPreflightEstimate {
  /** Conservative estimate of SOL that will land on the stealth after
   *  close + swap. Lamports. */
  estimatedRecoverableLamports: string;
  /** Smallest mixer denomination advertised by /relayer/info. */
  smallestDenominationLamports: string;
  /** True when the estimate is below smallest denom — UI shows dust warning. */
  willBeDust: boolean;
  /** Stealth pubkey — handy for the UI to show. */
  stealthPubkey: string;
  /** True when the on-chain PoolAuthority has already been reaped (a prior
   *  withdraw_close ran) and the SOL is simply sitting at the stealth
   *  wallet. In this state the orchestrator skips close + swap; the only
   *  remaining work is mixer round-trip or dust sweep. */
  positionAlreadyClosed: boolean;
}

/** The /executor/pool-authority endpoint returns 404 when the on-chain
 *  PoolAuthority account doesn't exist — either it was never opened, or it
 *  was reaped by a prior withdraw_close. Both look the same to the client;
 *  the orchestrator/UI treat them as "no live position" and offer the user
 *  the sweep / mixer-only path against whatever's sitting at the stealth. */
function isPoolAuthorityMissingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("API 404") ||
    err.message.includes("PoolAuthority not initialised")
  );
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
  // v2 (per-position) when positionId is provided. v1 (per-pool) is the
  // back-compat fallback for legacy positions opened before the
  // per-position change.
  onStep({ step: "derive", status: "active", message: "Authorize private exit in your wallet…" });
  let stealth: DerivedStealth;
  try {
    stealth = input.positionId
      ? await deriveStealthForPosition({
          mainWalletAddress: input.mainWalletAddress,
          poolAddress: input.poolAddress,
          positionId: input.positionId,
        })
      : await deriveStealthForPool({
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
  // PoolAuthority can legitimately be missing (404) when a prior run already
  // landed the close on-chain but failed at the mixer step. In that state the
  // SOL is sitting at the stealth wallet and the only work left is mixer (or
  // dust-sweep); steps 4 + 5 are no-ops.
  onStep({ step: "position-state", status: "active", message: "Reading position…" });
  let position: PositionStateView | null = null;
  let poolAuthority: PoolAuthorityInfo | null = null;
  let usePoolConfig: TestPairConfig | null = null;
  let positionAlreadyClosed = false;
  try {
    try {
      poolAuthority = await apiGet<PoolAuthorityInfo>(
        `/executor/pool-authority?stealth=${stealth.publicKey}&lbPair=${input.poolAddress}`,
      );
    } catch (err) {
      if (!isPoolAuthorityMissingError(err)) throw err;
      positionAlreadyClosed = true;
    }

    if (poolAuthority) {
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
    }
  } catch (err) {
    onStep({ step: "position-state", status: "error", message: describe(err) });
    throw err;
  }
  onStep({
    step: "position-state",
    status: "ok",
    data: positionAlreadyClosed
      ? { alreadyClosed: true }
      : { lbPair: usePoolConfig!.lbPair },
  });

  // ── 4. dlmm_withdraw_close — proceeds land at stealth ATAs ────────
  let closeSig: string | null = null;
  if (positionAlreadyClosed) {
    onStep({
      step: "close",
      status: "ok",
      message: "Position was already closed by a prior run — skipping.",
    });
    onStep({
      step: "swap",
      status: "ok",
      message: "Already consolidated by the prior run — skipping.",
    });
  } else {
    onStep({ step: "close", status: "active", message: "Closing position…" });
    try {
      const { transaction } = await apiPost<{ transaction: string }>("/executor/withdraw-close-tx", {
        stealth: stealth.publicKey,
        config: usePoolConfig!,
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
  }

  // ── 5. swap any non-SOL output to SOL via the same LP pool ───────
  // Single-sided SOL positions almost always close to a mix of SOL +
  // non-SOL token; the non-SOL side is whichever filled as price moved
  // through the bins. We swap that to SOL on the same lb_pair (per plan
  // §0, the same-pool fallback case). The slippage cap bounds the
  // self-front-run impact on this swap.
  let swapSig: string | null = null;
  if (!positionAlreadyClosed) {
    onStep({ step: "swap", status: "active", message: "Consolidating to SOL…" });
  try {
    const xIsSol = position!.tokenXMint === NATIVE_MINT;
    const yIsSol = position!.tokenYMint === NATIVE_MINT;
    if (!xIsSol && !yIsSol) {
      throw new Error(
        "Position is not SOL-paired. MVP only supports SOL-paired pools — " +
          "non-SOL-quoted exits are post-MVP work.",
      );
    }
    // The non-SOL side balance is whatever the close moved out of bins +
    // accrued fees on that side. We swap the full non-SOL balance.
    const nonSolBalanceLamports = BigInt(xIsSol ? position!.totalYLamports : position!.totalXLamports);
    const nonSolFeeLamports = BigInt(xIsSol ? position!.feeYLamports : position!.feeXLamports);
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
          `&allowedSlippageBps=${slippageBps}` +
          `&network=${NETWORK}`,
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
  }

  // ── 6. pick the largest denomination that fits in stealth's balance ─
  onStep({ step: "pick-denomination", status: "active", message: "Selecting mixer pool…" });
  let chosenDenom: bigint | null = null;
  let stealthBalanceLamports: bigint;
  let residueLamports: bigint;
  let needsDustSweep = false;
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
      // Post-close dust. Either fall through to the non-private sweep (when
      // the user pre-acknowledged it in the modal) or throw with the original
      // message so the caller can prompt for consent.
      if (!input.allowDustSweep) {
        throw new Error(
          `Stealth has ${available} lamports available — below smallest mixer denomination ` +
            `${availableDenoms[availableDenoms.length - 1]}. Try wait + claim, or sweep manually.`,
        );
      }
      needsDustSweep = true;
      residueLamports = 0n; // full balance leaves the stealth in the sweep
    } else {
      chosenDenom = fits;
      residueLamports = stealthBalanceLamports - chosenDenom;
    }
  } catch (err) {
    onStep({ step: "pick-denomination", status: "error", message: describe(err) });
    throw err;
  }
  onStep({
    step: "pick-denomination",
    status: "ok",
    data: needsDustSweep
      ? { mode: "swept", reason: "post-close balance below smallest denomination" }
      : {
          denominationLamports: chosenDenom!.toString(),
          residueLamports: residueLamports.toString(),
        },
  });

  // ── 6a. dust-sweep fallback — bypass the mixer entirely ─────────────
  if (needsDustSweep) {
    onStep({
      step: "dust-sweep",
      status: "active",
      message: "Sweeping non-privately to main wallet…",
    });
    let sweepResult;
    try {
      sweepResult = await executeStealthSweep({
        stealth,
        mainWalletAddress: input.mainWalletAddress,
      });
    } catch (err) {
      onStep({ step: "dust-sweep", status: "error", message: describe(err) });
      throw err;
    }
    onStep({
      step: "dust-sweep",
      status: "ok",
      data: {
        signature: sweepResult.signature ?? "",
        sweptLamports: sweepResult.sweptLamports,
      },
    });

    const sweptResult: PrivateExitResult = {
      mode: "swept",
      closeSignature: closeSig,
      swapSignature: swapSig,
      mixerDepositSignature: null,
      relayerWithdrawSignature: null,
      sweepSignature: sweepResult.signature,
      fundedLamports: sweepResult.sweptLamports,
      residueLamports: sweepResult.remainingLamports,
      selectedDenominationLamports: null,
    };
    onStep({ step: "done", status: "ok", data: sweptResult as unknown as Record<string, unknown> });
    return sweptResult;
  }

  // Past this point chosenDenom is set — the mixed path runs.
  const denomForMixer = chosenDenom!;

  // ── 7. mixer deposit ─────────────────────────────────────────────
  onStep({ step: "mixer-deposit", status: "active", message: "Depositing into mixer…" });
  let commitmentBundle;
  let mixerDepositSig: string;
  let leafIndex: number;
  try {
    commitmentBundle = await generateCommitment();
    const denomParam = denomForMixer.toString();

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
      denomination: denomForMixer.toString(),
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
      `/mixer/deposits?denomination=${denomForMixer.toString()}`,
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
      denomination: denomForMixer.toString(),
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
    mode: "mixed",
    closeSignature: closeSig,
    swapSignature: swapSig,
    mixerDepositSignature: mixerDepositSig,
    relayerWithdrawSignature: relayerSig,
    sweepSignature: null,
    fundedLamports,
    residueLamports: residueLamports.toString(),
    selectedDenominationLamports: denomForMixer.toString(),
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

/**
 * Read-only estimate of how much SOL a private exit will recover.
 *
 * No wallet popup — we already know the stealth pubkey from the stored
 * position, so we can hit /executor/pool-authority + /executor/position-state
 * + /dlmm/pools/{pool}/swap-quote without deriving. The estimate is
 * conservative (uses the swap quote's `minOut`, which already factors in
 * slippage) so a "willBeDust=true" prediction is sticky: if we say it'll be
 * dust, the actual close will also be dust. The reverse is not guaranteed —
 * a non-dust prediction can still hit dust if slippage worsens, which is
 * exactly why the orchestrator also implements the post-close fallback.
 */
export async function preflightEstimateExit(args: {
  stealthPubkey: string;
  poolAddress: string;
  slippageBps?: number;
}): Promise<ExitPreflightEstimate> {
  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  const relayerInfo = await apiGet<RelayerInfo>("/relayer/info");
  const availableDenoms = (relayerInfo.pools ?? [
    { denomination: relayerInfo.denominationLamports, mixerPoolAddress: relayerInfo.mixerPoolAddress },
  ])
    .map((p) => BigInt(p.denomination))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const smallestDenom = availableDenoms[availableDenoms.length - 1];

  let poolAuthority: PoolAuthorityInfo | null = null;
  try {
    poolAuthority = await apiGet<PoolAuthorityInfo>(
      `/executor/pool-authority?stealth=${args.stealthPubkey}&lbPair=${args.poolAddress}`,
    );
  } catch (err) {
    if (!isPoolAuthorityMissingError(err)) throw err;
  }

  // Position already closed: PoolAuthority was reaped by a prior
  // withdraw_close. The recoverable amount is whatever SOL is currently
  // sitting at the stealth wallet (less the rent reserve the orchestrator
  // also holds back at runtime).
  if (!poolAuthority) {
    const connection = new Connection(RPC_URL, "confirmed");
    const balance = BigInt(
      await connection.getBalance(new PublicKey(args.stealthPubkey)),
    );
    const estimated =
      balance > STEALTH_RESERVE_LAMPORTS ? balance - STEALTH_RESERVE_LAMPORTS : 0n;
    return {
      estimatedRecoverableLamports: estimated.toString(),
      smallestDenominationLamports: smallestDenom.toString(),
      willBeDust: estimated < smallestDenom,
      stealthPubkey: args.stealthPubkey,
      positionAlreadyClosed: true,
    };
  }

  const position = await apiGet<PositionStateView>(
    `/executor/position-state?lbPair=${args.poolAddress}&positionPubkey=${poolAuthority.positionPubkey}`,
  );

  const xIsSol = position.tokenXMint === NATIVE_MINT;
  const yIsSol = position.tokenYMint === NATIVE_MINT;
  // Non-SOL-paired pools are out of MVP scope; defer the actual error to the
  // run path and pretend the estimate isn't dust so the UI doesn't lie about
  // the recovery amount being 0.
  if (!xIsSol && !yIsSol) {
    return {
      estimatedRecoverableLamports: "0",
      smallestDenominationLamports: smallestDenom.toString(),
      willBeDust: false,
      stealthPubkey: args.stealthPubkey,
      positionAlreadyClosed: false,
    };
  }

  const solOnHand =
    BigInt(xIsSol ? position.totalXLamports : position.totalYLamports) +
    BigInt(xIsSol ? position.feeXLamports : position.feeYLamports);
  const nonSolOnHand =
    BigInt(xIsSol ? position.totalYLamports : position.totalXLamports) +
    BigInt(xIsSol ? position.feeYLamports : position.feeXLamports);

  let swapOut = 0n;
  if (nonSolOnHand > 0n) {
    try {
      const swapForY = !xIsSol;
      const quote = await apiGet<SwapQuoteResp>(
        `/dlmm/pools/${args.poolAddress}/swap-quote` +
          `?amountIn=${nonSolOnHand.toString()}` +
          `&swapForY=${swapForY}` +
          `&allowedSlippageBps=${slippageBps}` +
          `&network=${NETWORK}`,
      );
      swapOut = BigInt(quote.minOut);
    } catch {
      // Swap quote unavailable — conservatively assume zero SOL from the
      // non-SOL side. That over-predicts dust, which is the safer bias.
      swapOut = 0n;
    }
  }

  // Subtract the rent-style reserve we leave on stealth so the comparison
  // matches what the live orchestrator will actually have available at the
  // pick-denomination step.
  const estimated = solOnHand + swapOut > STEALTH_RESERVE_LAMPORTS
    ? solOnHand + swapOut - STEALTH_RESERVE_LAMPORTS
    : 0n;

  return {
    estimatedRecoverableLamports: estimated.toString(),
    smallestDenominationLamports: smallestDenom.toString(),
    willBeDust: estimated < smallestDenom,
    stealthPubkey: args.stealthPubkey,
    positionAlreadyClosed: false,
  };
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
