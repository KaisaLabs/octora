import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  deriveStealthForPool,
  deriveStealthForPosition,
  type DerivedStealth,
} from "./stealthVault";
import { breadcrumb } from "./observability";
import { NETWORK } from "./api";
import type { DistributionShape } from "@/components/octora/types";

/**
 * Private rebalance orchestrator (same-stealth, no mixer hop).
 *
 *  1. derive            — sign derivation message → recover stealth keypair (cached
 *                         within a session, so usually no wallet popup at all when
 *                         the user just opened a position in the same tab)
 *  2. position-state    — read current bin range + balances; also fetch the
 *                         use-pool config keyed to the OLD range so we can close
 *  3. close             — dlmm_withdraw_close (stealth signs); proceeds land at
 *                         stealth ATAs
 *  4. swap              — if a non-SOL leg has balance (price drifted off-peg
 *                         between bins), swap to SOL on the same lb_pair so we
 *                         can redeploy single-sided
 *  5. use-pool (new)    — fetch the TestPairConfig keyed to the NEW range
 *  6. init-position     — open a fresh position account under the same stealth
 *                         pubkey at the new [lower, upper]
 *  7. add-liquidity     — silent stealth sign; deploys the post-close SOL
 *                         balance (minus rent reserve) into the new range with
 *                         the new shape
 *
 * The mixer is deliberately NOT involved. The link between main wallet and
 * stealth was broken once at deposit time and is preserved here because every
 * signature in this flow comes from the same stealth keypair. To an observer
 * the rebalance looks like the position never went uncovered — close + open
 * land in the same block range under one stealth identity.
 */

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";
const RPC_URL =
  (import.meta.env.VITE_RPC_URL as string | undefined) ?? "https://api.devnet.solana.com";

const NATIVE_MINT = "So11111111111111111111111111111111111111112";
// Same rent reserve the deposit & exit orchestrators keep on the stealth so a
// follow-up tx can still pay for any new WSOL ATA without underflowing.
const STEALTH_RESERVE_LAMPORTS = 5_000_000n;
const DEFAULT_SLIPPAGE_BPS = 500; // 5 % — matches privateExit's swap leg.

export type RebalanceStepKey =
  | "derive"
  | "position-state"
  | "close"
  | "swap"
  | "use-pool"
  | "init-position"
  | "add-liquidity"
  | "done";

export interface RebalanceStepEvent {
  step: RebalanceStepKey;
  status: "active" | "ok" | "error";
  message?: string;
  data?: Record<string, unknown>;
}

export type RebalanceStepCallback = (event: RebalanceStepEvent) => void;

export interface PrivateRebalanceInput {
  /** Main wallet that opened the position (only used for v2 derivation). */
  mainWalletAddress: string;
  /** LP pool address (the lb_pair). */
  poolAddress: string;
  /**
   * The position's UUID, persisted in localPositions at deposit time. Drives
   * v2 stealth derivation. When omitted (legacy v1 positions), falls back to
   * `deriveStealthForPool({wallet, pool})`.
   */
  positionId?: string;
  /** New range lower bin (inclusive). */
  newLowerBinId: number;
  /** New range upper bin (inclusive). */
  newUpperBinId: number;
  /** New distribution shape applied at add-liquidity time. */
  newShape: DistributionShape;
  /** Override slippage on the post-close swap-to-SOL leg in BPS (0–2000). */
  slippageBps?: number;
}

export interface PrivateRebalanceResult {
  /** Withdraw-close on-chain signature for the old range. */
  closeSignature: string;
  /** Swap-to-SOL signature if a non-SOL leg was present; null otherwise. */
  swapSignature: string | null;
  /** init-position signature for the new range (null when reused). */
  initSignature: string | null;
  /** add-liquidity signature deploying SOL into the new range. */
  addLiquiditySignature: string;
  /** New position pubkey owned by the stealth — replaces the old one. */
  newPositionPubkey: string;
  /** Lamports actually deployed into the new range (post-rent-reserve). */
  fundedLamports: string;
}

export interface RebalancePreflightEstimate {
  /** Conservative estimate of SOL that will land on the stealth after close + swap. */
  estimatedRedeployableLamports: string;
  /** True when the position is no longer open on-chain (PoolAuthority missing). */
  positionAlreadyClosed: boolean;
  /** Stealth pubkey — handy for the modal to render. */
  stealthPubkey: string;
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
  minOut: string;
  allowedSlippageBps: number;
  consumedIn: string;
  feeLamports: string;
  priceImpact: string;
  endPrice: string;
  swapForY: boolean;
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

/** /executor/pool-authority returns 404 when the on-chain PoolAuthority is
 *  missing (never opened, or already reaped by withdraw_close). */
function isPoolAuthorityMissingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("API 404") ||
    err.message.includes("PoolAuthority not initialised")
  );
}

export async function runPrivateRebalance(
  input: PrivateRebalanceInput,
  onStepRaw: RebalanceStepCallback = () => {},
): Promise<PrivateRebalanceResult> {
  // Wrap onStep so every transition lands in Sentry breadcrumbs, scrubbed by
  // the observability layer — matches privateDeposit / privateExit.
  const onStep: RebalanceStepCallback = (event) => {
    breadcrumb(
      "privateRebalance",
      `${event.step}:${event.status}`,
      event.data,
      event.status === "error" ? "error" : "info",
    );
    onStepRaw(event);
  };

  const newWidth = input.newUpperBinId - input.newLowerBinId + 1;
  if (newWidth <= 0) {
    throw new Error("newUpperBinId must be >= newLowerBinId.");
  }

  const connection = new Connection(RPC_URL, "confirmed");
  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  // ── 1. derive stealth ─────────────────────────────────────────────
  onStep({
    step: "derive",
    status: "active",
    message: "Authorize private rebalance in your wallet…",
  });
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

  // ── 2. position state — fetch old range + use-pool config to close ─
  onStep({ step: "position-state", status: "active", message: "Reading position…" });
  let position: PositionStateView;
  let oldPoolConfig: TestPairConfig;
  try {
    let poolAuthority: PoolAuthorityInfo;
    try {
      poolAuthority = await apiGet<PoolAuthorityInfo>(
        `/executor/pool-authority?stealth=${stealth.publicKey}&lbPair=${input.poolAddress}`,
      );
    } catch (err) {
      if (isPoolAuthorityMissingError(err)) {
        throw new Error(
          "This position is no longer open on-chain. Refresh and try again, " +
            "or use Withdraw to recover any remaining stealth balance.",
        );
      }
      throw err;
    }
    if (poolAuthority.exitRecipient !== stealth.publicKey) {
      throw new Error(
        `exit_recipient is ${poolAuthority.exitRecipient}, expected ${stealth.publicKey}. ` +
          "Refusing — private rebalance requires exit_recipient = stealth.",
      );
    }
    position = await apiGet<PositionStateView>(
      `/executor/position-state?lbPair=${input.poolAddress}&positionPubkey=${poolAuthority.positionPubkey}`,
    );
    oldPoolConfig = await apiPost<TestPairConfig>("/executor/use-pool", {
      lbPair: input.poolAddress,
      width: position.upperBinId - position.lowerBinId + 1,
      lowerBinId: position.lowerBinId,
    });
  } catch (err) {
    onStep({ step: "position-state", status: "error", message: describe(err) });
    throw err;
  }
  onStep({
    step: "position-state",
    status: "ok",
    data: {
      oldLowerBinId: position.lowerBinId,
      oldUpperBinId: position.upperBinId,
      newLowerBinId: input.newLowerBinId,
      newUpperBinId: input.newUpperBinId,
    },
  });

  // ── 3. dlmm_withdraw_close — proceeds land at stealth ATAs ────────
  onStep({ step: "close", status: "active", message: "Closing old range…" });
  let closeSig: string;
  try {
    const { transaction } = await apiPost<{ transaction: string }>(
      "/executor/withdraw-close-tx",
      { stealth: stealth.publicKey, config: oldPoolConfig },
    );
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

  // ── 4. swap any non-SOL leg back to SOL via the same lb_pair ────────
  // Single-sided SOL positions usually close to a mix; whichever side filled
  // as price moved through the bins ends up at the stealth and needs to be
  // converted before we redeploy single-sided into the new range.
  onStep({ step: "swap", status: "active", message: "Consolidating to SOL…" });
  let swapSig: string | null = null;
  try {
    const xIsSol = position.tokenXMint === NATIVE_MINT;
    const yIsSol = position.tokenYMint === NATIVE_MINT;
    if (!xIsSol && !yIsSol) {
      throw new Error(
        "Position is not SOL-paired. MVP only supports SOL-paired pools — " +
          "non-SOL-quoted rebalances are post-MVP work.",
      );
    }
    const nonSolBalanceLamports = BigInt(
      xIsSol ? position.totalYLamports : position.totalXLamports,
    );
    const nonSolFeeLamports = BigInt(
      xIsSol ? position.feeYLamports : position.feeXLamports,
    );
    const totalNonSol = nonSolBalanceLamports + nonSolFeeLamports;

    if (totalNonSol > 0n) {
      const swapForY = !xIsSol; // tokenIn = non-SOL side
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

  // ── 5. use-pool — config for the NEW range ───────────────────────
  onStep({ step: "use-pool", status: "active", message: "Loading new range…" });
  let newPoolConfig: TestPairConfig;
  try {
    newPoolConfig = await apiPost<TestPairConfig>("/executor/use-pool", {
      lbPair: input.poolAddress,
      width: newWidth,
      lowerBinId: input.newLowerBinId,
    });
  } catch (err) {
    onStep({ step: "use-pool", status: "error", message: describe(err) });
    throw err;
  }
  onStep({ step: "use-pool", status: "ok", data: { lbPair: newPoolConfig.lbPair } });

  // ── 6. init-position — open a fresh account at the new range ─────
  onStep({ step: "init-position", status: "active", message: "Opening new range…" });
  let initSig: string | null = null;
  let initResp: InitPositionResponse;
  try {
    initResp = await apiPost<InitPositionResponse>("/executor/init-position-tx", {
      stealth: stealth.publicKey,
      lbPair: newPoolConfig.lbPair,
      exitRecipient: stealth.publicKey,
      lowerBinId: newPoolConfig.lowerBinId,
      width: newPoolConfig.width,
    });
    if (initResp.alreadyInitialized || initResp.transaction === null) {
      // A prior rebalance attempt got this far before failing at add-liquidity.
      // Re-use the existing position account.
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

  // ── 7. add-liquidity — redeploy stealth SOL balance into new range ─
  onStep({ step: "add-liquidity", status: "active", message: "Adding single-sided SOL…" });
  let fundSig: string;
  let totalSolLamports: bigint;
  try {
    const stealthBalanceLamports = BigInt(
      await connection.getBalance(new PublicKey(stealth.publicKey)),
    );
    totalSolLamports = stealthBalanceLamports - STEALTH_RESERVE_LAMPORTS;
    if (totalSolLamports <= 0n) {
      throw new Error(
        `Stealth balance ${stealthBalanceLamports} below rent reserve ${STEALTH_RESERVE_LAMPORTS}. ` +
          "Close + swap may have underdelivered — try Withdraw to recover.",
      );
    }
    const { transaction } = await apiPost<AddLiquidityResponse>(
      "/executor/add-liquidity-tx",
      {
        stealth: stealth.publicKey,
        config: newPoolConfig,
        totalSolLamports: totalSolLamports.toString(),
        shape: input.newShape,
      },
    );
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

  const result: PrivateRebalanceResult = {
    closeSignature: closeSig,
    swapSignature: swapSig,
    initSignature: initSig,
    addLiquiditySignature: fundSig,
    newPositionPubkey: initResp.positionPubkey,
    fundedLamports: totalSolLamports.toString(),
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
 * Read-only estimate of how much SOL a rebalance will redeploy. No wallet
 * popup — uses the stored stealth pubkey to read position state + swap quote.
 * Symmetric to `preflightEstimateExit` but doesn't gate on the smallest mixer
 * denomination since rebalance doesn't touch the mixer.
 */
export async function preflightEstimateRebalance(args: {
  stealthPubkey: string;
  poolAddress: string;
  slippageBps?: number;
}): Promise<RebalancePreflightEstimate> {
  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  let poolAuthority: PoolAuthorityInfo | null = null;
  try {
    poolAuthority = await apiGet<PoolAuthorityInfo>(
      `/executor/pool-authority?stealth=${args.stealthPubkey}&lbPair=${args.poolAddress}`,
    );
  } catch (err) {
    if (!isPoolAuthorityMissingError(err)) throw err;
  }

  if (!poolAuthority) {
    const connection = new Connection(RPC_URL, "confirmed");
    const lamports = BigInt(
      await connection.getBalance(new PublicKey(args.stealthPubkey)),
    );
    const redeployable =
      lamports > STEALTH_RESERVE_LAMPORTS ? lamports - STEALTH_RESERVE_LAMPORTS : 0n;
    return {
      estimatedRedeployableLamports: redeployable.toString(),
      positionAlreadyClosed: true,
      stealthPubkey: args.stealthPubkey,
    };
  }

  const position = await apiGet<PositionStateView>(
    `/executor/position-state?lbPair=${args.poolAddress}&positionPubkey=${poolAuthority.positionPubkey}`,
  );

  const xIsSol = position.tokenXMint === NATIVE_MINT;
  const yIsSol = position.tokenYMint === NATIVE_MINT;
  const solBalanceLamports = BigInt(xIsSol ? position.totalXLamports : position.totalYLamports);
  const solFeeLamports = BigInt(xIsSol ? position.feeXLamports : position.feeYLamports);
  const nonSolBalanceLamports = BigInt(
    xIsSol ? position.totalYLamports : position.totalXLamports,
  );
  const nonSolFeeLamports = BigInt(xIsSol ? position.feeYLamports : position.feeXLamports);
  const totalNonSol = nonSolBalanceLamports + nonSolFeeLamports;

  let swappedSol = 0n;
  if ((xIsSol || yIsSol) && totalNonSol > 0n) {
    const swapForY = !xIsSol;
    try {
      const quote = await apiGet<SwapQuoteResp>(
        `/dlmm/pools/${args.poolAddress}/swap-quote` +
          `?amountIn=${totalNonSol.toString()}` +
          `&swapForY=${swapForY}` +
          `&allowedSlippageBps=${slippageBps}` +
          `&network=${NETWORK}`,
      );
      swappedSol = BigInt(quote.minOut);
    } catch {
      // Quote unavailable (devnet pool with no liquidity, etc.) — fall back to
      // ignoring the non-SOL leg in the estimate. The real flow will surface
      // the swap failure cleanly at step 4.
    }
  }

  const projectedStealthLamports = solBalanceLamports + solFeeLamports + swappedSol;
  const redeployable =
    projectedStealthLamports > STEALTH_RESERVE_LAMPORTS
      ? projectedStealthLamports - STEALTH_RESERVE_LAMPORTS
      : 0n;

  return {
    estimatedRedeployableLamports: redeployable.toString(),
    positionAlreadyClosed: false,
    stealthPubkey: args.stealthPubkey,
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
