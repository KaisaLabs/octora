import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, Copy, ExternalLink, FlaskConical, Loader2, ShieldCheck, X } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

import type { Pool, DistributionShape } from "@/components/octora/types";
import { useSolana } from "@/providers/SolanaProvider";
import { getPrices, type PriceMap } from "@/lib/api";
import {
  runPrivateDeposit,
  type DepositStepEvent,
  type DepositStepKey,
  type PrivateDepositResult,
} from "@/lib/privateDeposit";
import { addLocalPosition } from "@/lib/localPositions";
import { NETWORK } from "@/lib/api";
import { hasSeenStealthExplainer, markStealthExplainerSeen } from "@/lib/stealthAck";
import { isNetworkUnsafe, useNetworkStatus } from "@/lib/networkStatus";
import { StealthExplainerModal } from "./StealthExplainerModal";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pool: Pool;
  depositUsd: number;
  shape: DistributionShape;
  range: { lower: number; upper: number };
  /** Token-decimals fallback when /api/prices doesn't return data. Optional. */
  fallbackDecimals?: { tokenA: number; tokenB: number };
}

type Phase = "preview" | "running" | "success" | "error";

interface Breakdown {
  usdA: number;
  usdB: number;
  tokenAmountA: number;
  tokenAmountB: number;
  amountX: bigint;
  amountY: bigint;
  hasPrices: boolean;
  /** True when devnet 1:1 fallback was used to fill in missing oracle prices. */
  usedDevnetFallback: boolean;
}

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";
const RPC_URL =
  (import.meta.env.VITE_RPC_URL as string | undefined) ?? "https://api.devnet.solana.com";

/**
 * Devnet test mode — relaxes UX gates so dev pools (test mints with no
 * Jupiter price) can complete the flow end-to-end. Auto-derived from the
 * configured RPC URL so it stays off in mainnet builds.
 */
const IS_DEVNET =
  RPC_URL.includes("devnet") ||
  RPC_URL.includes("127.0.0.1") ||
  RPC_URL.includes("localhost");

/** Decimal default used by the test-mint helper and the 1:1 USD fallback. */
const DEVNET_FALLBACK_DECIMALS = 6;

const STEP_LABELS: Record<DepositStepKey, string> = {
  derive: "Authorize private session",
  "relayer-info": "Fetch mixer config",
  prepare: "Register privacy intent",
  "mixer-deposit": "Deposit into mixer",
  "confirm-deposit": "Record deposit",
  "build-tree": "Reconstruct Merkle tree",
  prove: "Generate ZK proof",
  "relayer-withdraw": "Relayer funds stealth",
  "use-pool": "Load pool state",
  "init-position": "Open private position",
  "add-liquidity": "Add single-sided SOL",
  done: "Done",
};

const STEP_ORDER: DepositStepKey[] = [
  "derive",
  "relayer-info",
  "prepare",
  "mixer-deposit",
  "confirm-deposit",
  "build-tree",
  "prove",
  "relayer-withdraw",
  "use-pool",
  "init-position",
  "add-liquidity",
];

export function PrivateDepositModal({
  open,
  onOpenChange,
  pool,
  depositUsd,
  shape,
  range,
  fallbackDecimals,
}: Props) {
  const { wallet } = useSolana();
  const networkStatus = useNetworkStatus();
  const networkUnsafe = isNetworkUnsafe(networkStatus);

  const [prices, setPrices] = useState<PriceMap | null>(null);
  const [pricesError, setPricesError] = useState<string | null>(null);

  // P1-38: surface the stealth-wallet recovery model the first time a
  // wallet opens the deposit modal. Per-wallet flag — switching wallets
  // re-opens the explainer, which is correct (a different user is
  // arriving at the same UI for the first time).
  const [stealthExplainerOpen, setStealthExplainerOpen] = useState(false);
  useEffect(() => {
    if (!open || !wallet.connected || !wallet.address) {
      setStealthExplainerOpen(false);
      return;
    }
    setStealthExplainerOpen(!hasSeenStealthExplainer(wallet.address));
  }, [open, wallet.connected, wallet.address]);

  const [phase, setPhase] = useState<Phase>("preview");
  const initialStepStatuses = (): Record<DepositStepKey, "pending" | "active" | "ok" | "error"> => ({
    derive: "pending",
    "relayer-info": "pending",
    prepare: "pending",
    "mixer-deposit": "pending",
    "confirm-deposit": "pending",
    "build-tree": "pending",
    prove: "pending",
    "relayer-withdraw": "pending",
    "use-pool": "pending",
    "init-position": "pending",
    "add-liquidity": "pending",
    done: "pending",
  });
  const [stepStatuses, setStepStatuses] = useState<
    Record<DepositStepKey, "pending" | "active" | "ok" | "error">
  >(initialStepStatuses);
  const [activeMessage, setActiveMessage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [result, setResult] = useState<PrivateDepositResult | null>(null);

  // Reset every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setPhase("preview");
    setErrorMessage("");
    setResult(null);
    setStepStatuses(initialStepStatuses());

    let cancelled = false;
    setPrices(null);
    setPricesError(null);
    getPrices([pool.tokenAMint, pool.tokenBMint])
      .then((p) => {
        if (!cancelled) setPrices(p);
      })
      .catch((err) => {
        if (!cancelled) setPricesError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, pool.tokenAMint, pool.tokenBMint]);

  /**
   * When set, the modal targets a freshly-created relayer-owned test pool
   * instead of `pool`. This lets devnet users escape the OwnerMismatch trap
   * (mints we don't own) without leaving the page.
   */
  interface TestTarget {
    address: string;
    tokenAMint: string;
    tokenBMint: string;
    tokenA: string;
    tokenB: string;
    lowerBinId: number;
    upperBinId: number;
    decimals: number;
  }
  const [testTarget, setTestTarget] = useState<TestTarget | null>(null);

  // Reset the override every time the modal closes/reopens so the next session
  // starts clean against the pool the user navigated to.
  useEffect(() => {
    if (!open) setTestTarget(null);
  }, [open]);

  const effective = useMemo(
    () =>
      testTarget ?? {
        address: pool.address,
        tokenAMint: pool.tokenAMint,
        tokenBMint: pool.tokenBMint,
        tokenA: pool.tokenA,
        tokenB: pool.tokenB,
        lowerBinId: range.lower,
        upperBinId: range.upper,
        decimals: 0, // unused when testTarget is null; price lookup gives decimals
      },
    [
      testTarget,
      pool.address,
      pool.tokenAMint,
      pool.tokenBMint,
      pool.tokenA,
      pool.tokenB,
      range.lower,
      range.upper,
    ],
  );

  const breakdown = useMemo<Breakdown>(() => {
    const usdA = (depositUsd * pool.allocation.tokenA) / 100;
    const usdB = (depositUsd * pool.allocation.tokenB) / 100;

    const priceA = prices?.[effective.tokenAMint];
    const priceB = prices?.[effective.tokenBMint];
    let usdPriceA = priceA?.usdPrice ?? 0;
    let usdPriceB = priceB?.usdPrice ?? 0;
    const decA =
      priceA?.decimals ?? testTarget?.decimals ?? fallbackDecimals?.tokenA ?? DEVNET_FALLBACK_DECIMALS;
    const decB =
      priceB?.decimals ?? testTarget?.decimals ?? fallbackDecimals?.tokenB ?? DEVNET_FALLBACK_DECIMALS;

    // Devnet shortcut: when the oracle has no quote (typical for test mints),
    // pretend $1 = 1 token so the UI can complete the flow without a real
    // price source. Mainnet builds never hit this branch.
    let usedDevnetFallback = false;
    if (IS_DEVNET) {
      if (usdPriceA <= 0) {
        usdPriceA = 1;
        usedDevnetFallback = true;
      }
      if (usdPriceB <= 0) {
        usdPriceB = 1;
        usedDevnetFallback = true;
      }
    }

    const tokenAmountA = usdPriceA > 0 ? usdA / usdPriceA : 0;
    const tokenAmountB = usdPriceB > 0 ? usdB / usdPriceB : 0;

    const amountX = BigInt(Math.floor(tokenAmountA * 10 ** decA));
    const amountY = BigInt(Math.floor(tokenAmountB * 10 ** decB));

    return {
      usdA,
      usdB,
      tokenAmountA,
      tokenAmountB,
      amountX,
      amountY,
      hasPrices: usdPriceA > 0 && usdPriceB > 0,
      usedDevnetFallback,
    };
  }, [
    prices,
    depositUsd,
    pool.allocation.tokenA,
    pool.allocation.tokenB,
    effective.tokenAMint,
    effective.tokenBMint,
    testTarget?.decimals,
    fallbackDecimals?.tokenA,
    fallbackDecimals?.tokenB,
  ]);

  // Block submit when the genesis-hash check failed or the RPC is
  // unreachable (P1-35). The explainer modal does NOT block submit
  // (it's UX, not a security gate); we just open it on first deposit.
  const ready =
    wallet.connected && breakdown.hasPrices && phase === "preview" && !networkUnsafe;

  const [mintState, setMintState] = useState<{
    status: "idle" | "loading" | "ok" | "error";
    message?: string;
  }>({ status: "idle" });

  const mintTestTokens = async (target: { tokenAMint: string; tokenBMint: string }) => {
    if (!wallet.address) throw new Error("Wallet not connected.");
    const generous = (BigInt(10 ** DEVNET_FALLBACK_DECIMALS) * 100_000n).toString();
    const res = await fetch(`${API_BASE}/executor/mint-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner: wallet.address,
        tokenX: target.tokenAMint,
        tokenY: target.tokenBMint,
        amountX: generous,
        amountY: generous,
      }),
    });
    if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
  };

  const handleMintCurrent = async () => {
    setMintState({ status: "loading", message: "Minting test tokens…" });
    try {
      await mintTestTokens({ tokenAMint: pool.tokenAMint, tokenBMint: pool.tokenBMint });
      setMintState({ status: "ok", message: "Test tokens minted to your wallet." });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMintState({
        status: "error",
        message: `Mint failed: ${msg}. The relayer doesn't own these mints — use "Create devnet test pool" instead.`,
      });
    }
  };

  const bootstrapTestPool = async () => {
    if (!wallet.address) return;
    setMintState({ status: "loading", message: "Creating fresh devnet test pool…" });
    try {
      const setupRes = await fetch(`${API_BASE}/executor/setup-pair`, { method: "POST" });
      if (!setupRes.ok) throw new Error(`setup-pair ${setupRes.status}: ${await setupRes.text()}`);
      const config = (await setupRes.json()) as {
        tokenX: string;
        tokenY: string;
        lbPair: string;
        lowerBinId: number;
        upperBinId: number;
      };

      setMintState({ status: "loading", message: "Minting test tokens to your wallet…" });
      await mintTestTokens({ tokenAMint: config.tokenX, tokenBMint: config.tokenY });

      setTestTarget({
        address: config.lbPair,
        tokenAMint: config.tokenX,
        tokenBMint: config.tokenY,
        tokenA: "TEST_X",
        tokenB: "TEST_Y",
        lowerBinId: config.lowerBinId,
        upperBinId: config.upperBinId,
        decimals: DEVNET_FALLBACK_DECIMALS,
      });
      setMintState({
        status: "ok",
        message: "Fresh test pool ready. Click Authorize to deposit privately.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMintState({ status: "error", message: `Bootstrap failed: ${msg}` });
    }
  };

  const handleStep = (event: DepositStepEvent) => {
    setStepStatuses((prev) => ({ ...prev, [event.step]: event.status === "active" ? "active" : event.status === "ok" ? "ok" : "error" }));
    if (event.message) setActiveMessage(event.message);
    if (event.status === "error" && event.message) setErrorMessage(event.message);
  };

  const start = async () => {
    if (!wallet.address) return;
    setPhase("running");
    setActiveMessage("");
    setErrorMessage("");
    try {
      const res = await runPrivateDeposit(
        {
          mainWalletAddress: wallet.address,
          poolAddress: effective.address,
          lowerBinId: effective.lowerBinId,
          upperBinId: effective.upperBinId,
          shape,
        },
        handleStep,
      );
      setResult(res);
      setPhase("success");
      // Record the deposit in the wallet's local index so the portfolio
      // can render it. The chain doesn't link main wallet → stealth, so
      // the browser is the only place that knows about this position.
      try {
        addLocalPosition(wallet.address, {
          positionId: res.positionId,
          poolAddress: effective.address,
          positionPubkey: res.positionPubkey,
          stealthPubkey: res.stealthPubkey,
          fundedLamports: res.fundedLamports,
          depositedUsd: depositUsd,
          lowerBinId: effective.lowerBinId,
          upperBinId: effective.upperBinId,
          shape,
          ts: Date.now(),
          network: NETWORK,
          signatures: {
            mixerDeposit: res.mixerDepositSignature,
            relayerWithdraw: res.relayerWithdrawSignature,
            init: res.initSignature,
            fund: res.fundSignature,
          },
        });
      } catch (err) {
        // Non-fatal: portfolio just won't show this entry until next deposit.
        // eslint-disable-next-line no-console
        console.warn("[PrivateDepositModal] failed to persist position to local index:", err);
      }
    } catch {
      setPhase("error");
    }
  };

  const close = () => {
    if (phase === "running") return; // don't allow closing mid-flight
    onOpenChange(false);
  };

  return (
    <>
    <StealthExplainerModal
      open={stealthExplainerOpen}
      onContinue={() => {
        if (wallet.address) markStealthExplainerSeen(wallet.address);
        setStealthExplainerOpen(false);
      }}
      onCancel={() => {
        // User dismissed without confirming. Close the deposit modal too —
        // sending them straight at the spinner would skip the recovery
        // explainer they just declined.
        setStealthExplainerOpen(false);
        onOpenChange(false);
      }}
    />
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md border-border bg-surface-elevated p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border/60 px-6 py-4">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Deposit privately
          </DialogTitle>
        </DialogHeader>

        <div className="px-6 py-5">
          {phase === "preview" && (
            <PreviewBody
              pool={pool}
              depositUsd={depositUsd}
              shape={shape}
              range={range}
              breakdown={breakdown}
              walletConnected={wallet.connected}
              pricesError={pricesError}
              mintState={mintState}
              onMintTestTokens={handleMintCurrent}
              onBootstrapTestPool={bootstrapTestPool}
              testTarget={testTarget}
            />
          )}
          {(phase === "running" || phase === "error") && (
            <RunningBody
              steps={stepStatuses}
              activeMessage={activeMessage}
              errorMessage={errorMessage}
            />
          )}
          {phase === "success" && result && (
            <SuccessBody pool={pool} result={result} />
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-border/60 bg-card/40 px-6 py-4">
          {phase === "preview" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="hero" onClick={start} disabled={!ready}>
                Authorize private session
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </>
          )}
          {phase === "running" && (
            <span className="text-xs text-muted-foreground">
              Don't close this window — it'll resume from where it left off otherwise.
            </span>
          )}
          {phase === "error" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button variant="hero" onClick={start}>
                Try again
              </Button>
            </>
          )}
          {phase === "success" && (
            <Button variant="hero" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}

interface TestTargetSummary {
  address: string;
  tokenA: string;
  tokenB: string;
  lowerBinId: number;
  upperBinId: number;
}

function PreviewBody({
  pool,
  depositUsd,
  shape,
  range,
  breakdown,
  walletConnected,
  pricesError,
  mintState,
  onMintTestTokens,
  onBootstrapTestPool,
  testTarget,
}: {
  pool: Pool;
  depositUsd: number;
  shape: DistributionShape;
  range: { lower: number; upper: number };
  breakdown: Breakdown;
  walletConnected: boolean;
  pricesError: string | null;
  mintState: { status: "idle" | "loading" | "ok" | "error"; message?: string };
  onMintTestTokens: () => void;
  onBootstrapTestPool: () => void;
  testTarget: TestTargetSummary | null;
}) {
  // When a fresh test pool is in play, display the test pool's params instead
  // of the pool the user originally navigated to.
  const displayTokenA = testTarget?.tokenA ?? pool.tokenA;
  const displayTokenB = testTarget?.tokenB ?? pool.tokenB;
  const displayLower = testTarget?.lowerBinId ?? range.lower;
  const displayUpper = testTarget?.upperBinId ?? range.upper;
  const binsCovered = Math.max(0, displayUpper - displayLower + 1);

  return (
    <div className="space-y-5 text-sm">
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">You'll deposit</p>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <DepositTile
            symbol={displayTokenA}
            usd={breakdown.usdA}
            tokens={breakdown.tokenAmountA}
            placeholder={!breakdown.hasPrices}
          />
          <DepositTile
            symbol={displayTokenB}
            usd={breakdown.usdB}
            tokens={breakdown.tokenAmountB}
            placeholder={!breakdown.hasPrices}
          />
        </div>
      </div>

      <dl className="space-y-2.5 rounded-xl border border-border bg-card/60 p-4 text-sm">
        <Row label="Pool" value={`${displayTokenA}/${displayTokenB}`} />
        <Row label="Shape" value={capitalize(shape)} />
        <Row label="Range" value={`${binsCovered} bins (${displayLower} → ${displayUpper})`} />
        <Row label="Total" value={`$${depositUsd.toLocaleString()}`} />
        {testTarget && (
          <Row
            label="Test pool"
            value={`${testTarget.address.slice(0, 6)}…${testTarget.address.slice(-4)}`}
          />
        )}
      </dl>

      <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-xs leading-5 text-foreground/80">
        <div className="mb-1.5 flex items-center gap-1.5 font-medium text-primary">
          <ShieldCheck className="h-3.5 w-3.5" />
          One signature, fully private
        </div>
        Step 1 derives your private address (free, no gas). Step 2 funds the position
        on-chain. Your main wallet never appears as the LP owner.
      </div>

      {IS_DEVNET && (breakdown.usedDevnetFallback || testTarget) && (
        <div className="space-y-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs leading-5 text-amber-200">
          <div className="flex items-center gap-1.5 font-medium text-amber-300">
            <FlaskConical className="h-3.5 w-3.5" />
            Devnet test mode
          </div>
          {testTarget ? (
            <p className="text-amber-200/90">
              Targeting a fresh relayer-owned test pool with minted tokens. Click
              <span className="mx-0.5 font-medium text-amber-100">Authorize private session</span>
              to run the deposit end-to-end.
            </p>
          ) : (
            <p className="text-amber-200/90">
              No oracle price for one or both mints. Try minting tokens for this pool
              — it only works if the relayer created the mints. If that fails, bootstrap
              a fresh relayer-owned pool to test against instead.
            </p>
          )}

          {!testTarget && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onMintTestTokens}
                disabled={!walletConnected || mintState.status === "loading"}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 font-medium text-amber-200 transition-colors hover:bg-amber-500/15 disabled:opacity-50"
              >
                {mintState.status === "loading" ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" /> Working…
                  </>
                ) : (
                  <>Mint for this pool</>
                )}
              </button>
              <button
                type="button"
                onClick={onBootstrapTestPool}
                disabled={!walletConnected || mintState.status === "loading"}
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 font-medium text-emerald-200 transition-colors hover:bg-emerald-500/15 disabled:opacity-50"
              >
                Create devnet test pool
              </button>
            </div>
          )}

          {mintState.message && (
            <p
              className={
                mintState.status === "error"
                  ? "text-rose-300"
                  : mintState.status === "ok"
                    ? "text-emerald-300"
                    : "text-amber-200/90"
              }
            >
              {mintState.message}
            </p>
          )}
        </div>
      )}

      {!walletConnected && (
        <p className="text-xs text-amber-400">Connect your wallet to continue.</p>
      )}
      {pricesError && !IS_DEVNET && (
        <p className="text-xs text-amber-400">
          Couldn't load token prices. {pricesError}
        </p>
      )}
    </div>
  );
}

function RunningBody({
  steps,
  activeMessage,
  errorMessage,
}: {
  steps: Record<DepositStepKey, "pending" | "active" | "ok" | "error">;
  activeMessage: string;
  errorMessage: string;
}) {
  return (
    <div className="space-y-3 text-sm">
      <ol className="space-y-2.5">
        {STEP_ORDER.map((key) => {
          const status = steps[key];
          return (
            <li key={key} className="flex items-center gap-3">
              <StepDot status={status} />
              <span
                className={
                  status === "ok"
                    ? "text-foreground"
                    : status === "active"
                      ? "text-foreground"
                      : status === "error"
                        ? "text-rose-400"
                        : "text-muted-foreground"
                }
              >
                {STEP_LABELS[key]}
              </span>
            </li>
          );
        })}
      </ol>
      {activeMessage && !errorMessage && (
        <p className="rounded-lg border border-border bg-card/60 px-3 py-2 text-xs text-muted-foreground">
          {activeMessage}
        </p>
      )}
      {errorMessage && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs leading-5 text-rose-300">
          {errorMessage}
        </p>
      )}
    </div>
  );
}

function SuccessBody({ pool, result }: { pool: Pool; result: PrivateDepositResult }) {
  const explorer = (sig: string) =>
    `https://solscan.io/tx/${sig}?cluster=devnet`;

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
        <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="h-4 w-4" />
        </div>
        <div>
          <p className="font-medium text-foreground">Position opened privately</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            Liquidity is live in {pool.tokenA}/{pool.tokenB}. The DLMM only sees
            your stealth address.
          </p>
        </div>
      </div>

      <CopyRow label="Stealth address" value={result.stealthPubkey} />
      <CopyRow label="Position" value={result.positionPubkey} />

      <div className="space-y-2 rounded-xl border border-border bg-card/60 p-4">
        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
          Transactions
        </p>
        <ExplorerLink label="Position init" href={explorer(result.initSignature)} />
        <ExplorerLink label="Liquidity funded" href={explorer(result.fundSignature)} />
      </div>
    </div>
  );
}

function DepositTile({
  symbol,
  usd,
  tokens,
  placeholder,
}: {
  symbol: string;
  usd: number;
  tokens: number;
  placeholder: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-3">
      <p className="text-xs text-muted-foreground">{symbol}</p>
      <p className="mt-1.5 font-mono text-lg font-semibold tabular-nums">
        {placeholder ? "—" : formatTokens(tokens)}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">${usd.toFixed(0)}</p>
    </div>
  );
}

function StepDot({ status }: { status: "pending" | "active" | "ok" | "error" }) {
  if (status === "ok") {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Check className="h-3 w-3" />
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-primary">
        <Loader2 className="h-3 w-3 animate-spin" />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-white">
        <X className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card/60 px-3 py-2 text-xs">
      <div className="min-w-0">
        <p className="text-muted-foreground">{label}</p>
        <p className="truncate font-mono text-[11px] text-foreground/90">{value}</p>
      </div>
      <button
        type="button"
        onClick={() => navigator.clipboard?.writeText(value)}
        className="shrink-0 rounded-md border border-border bg-background p-1.5 text-muted-foreground transition-colors hover:text-foreground"
        aria-label="Copy"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ExplorerLink({ label, href }: { label: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <span>{label}</span>
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.001) return n.toFixed(5);
  return n.toExponential(3);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

