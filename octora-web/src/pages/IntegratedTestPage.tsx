/**
 * Integrated test page — runs the full mixer → relayer → executor lifecycle
 * end-to-end in the browser.
 *
 *   1. Mixer pool init / status
 *   2. Generate commitment (browser)
 *   3. Deposit to mixer
 *   4. Generate stealth wallet (browser)
 *   5. Generate Groth16 withdrawal proof (browser)
 *   6. Withdraw from mixer to stealth wallet
 *
 *   ── executor + DLMM ──
 *   7. Server-side: create test mints + LB pair + bin arrays
 *   8. Mint test tokens to user wallet
 *   9. init_position via executor (stealth signs; PA PDA owns DLMM position)
 *  10. add_liquidity via executor (user wallet + stealth co-sign)
 *  11. withdraw_close via executor (stealth signs; tokens → user as exit_recipient)
 *
 * All secrets (commitment secret + nullifier, stealth secret key) stay in
 * browser memory — the API only sees public values and unsigned txs.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useSolana } from "@/providers/SolanaProvider";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  generateCommitment,
  createMixerMerkleTree,
  generateStealthWallet,
  buildWithdrawCircuitInput,
  generateWithdrawProof,
  convertProofToBytes,
  convertPublicInputsToBytes,
  pubkeyToFieldHash,
  uint8ArrayToBase64,
  type Commitment,
  type MixerMerkleTree,
  type StealthWallet,
  type WithdrawProofResult,
} from "@/lib/mixer";

const API = import.meta.env.VITE_API_URL ?? "/api";
// Default to devnet so the page works against deployed programs without
// running a local validator. Override with VITE_RPC_URL=http://localhost:8899
// when developing against a localnet.
const RPC_URL =
  import.meta.env.VITE_RPC_URL ?? "https://api.devnet.solana.com";

interface StepState {
  status: "idle" | "loading" | "success" | "error";
  message?: string;
  data?: unknown;
}

interface DepositSummary {
  commitment: string;
  leafIndex: number;
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

interface DevnetPool {
  address: string;
  name: string;
  mintX: string;
  mintY: string;
  binStep: number;
  currentPrice: number;
  reserveXAmount: number;
  reserveYAmount: number;
  liquidity: string;
  isVerified: boolean;
}

async function apiPost(path: string, body?: unknown) {
  // Fastify with the JSON content-type parser rejects POSTs that declare
  // application/json but ship an empty body (FST_ERR_CTP_EMPTY_JSON_BODY).
  // Only set the header when we actually have a body to send.
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiGet(path: string) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Sign + send a base64 tx with the user's wallet only. */
async function signAndSendUser(txBase64: string): Promise<string> {
  const provider = (window as any).solana;
  if (!provider) throw new Error("No Solana wallet found");
  const connection = new Connection(RPC_URL, "confirmed");
  const tx = Transaction.from(Uint8Array.from(atob(txBase64), (c) => c.charCodeAt(0)));
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const signed = await provider.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/**
 * Sign + send an executor tx that needs the stealth keypair AND optionally
 * the user wallet. The server has already partial-signed as fee payer (and
 * the position keypair on init), so we add stealth here and (if needed)
 * have the user wallet adapter sign too.
 */
async function signAndSendStealth(opts: {
  txBase64: string;
  stealth: StealthWallet;
  alsoSignWithUserWallet?: boolean;
}): Promise<string> {
  const connection = new Connection(RPC_URL, "confirmed");
  const tx = Transaction.from(Uint8Array.from(atob(opts.txBase64), (c) => c.charCodeAt(0)));

  // Server set a recentBlockhash but it may be stale by the time we sign;
  // refresh so we don't burn a wallet prompt on a "Blockhash not found".
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  // Stealth signs first — anything in browser memory should sign before we
  // hand off to the wallet adapter (a wallet prompt is the riskiest step
  // for the user; minimise window-of-uncertainty if they get cold feet).
  tx.partialSign(opts.stealth.keypair);

  let serialized: Buffer;
  if (opts.alsoSignWithUserWallet) {
    const provider = (window as any).solana;
    if (!provider) throw new Error("No Solana wallet found");
    const signed = await provider.signTransaction(tx);
    serialized = signed.serialize();
  } else {
    serialized = tx.serialize();
  }

  const sig = await connection.sendRawTransaction(serialized, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

export function IntegratedTestPage() {
  const { wallet, connect } = useSolana();

  // ── Mixer step states ──
  const [poolStatus, setPoolStatus] = useState<StepState>({ status: "idle" });
  const [initStep, setInitStep] = useState<StepState>({ status: "idle" });
  const [commitmentStep, setCommitmentStep] = useState<StepState>({ status: "idle" });
  const [depositStep, setDepositStep] = useState<StepState>({ status: "idle" });
  const [stealthStep, setStealthStep] = useState<StepState>({ status: "idle" });
  const [proveStep, setProveStep] = useState<StepState>({ status: "idle" });
  const [withdrawStep, setWithdrawStep] = useState<StepState>({ status: "idle" });

  // ── Executor step states ──
  const [setupPairStep, setSetupPairStep] = useState<StepState>({ status: "idle" });
  const [mintTokensStep, setMintTokensStep] = useState<StepState>({ status: "idle" });
  const [initPositionStep, setInitPositionStep] = useState<StepState>({ status: "idle" });
  const [addLiquidityStep, setAddLiquidityStep] = useState<StepState>({ status: "idle" });
  const [withdrawCloseStep, setWithdrawCloseStep] = useState<StepState>({ status: "idle" });

  // ── Pool source: fresh test pair vs existing devnet pool ──
  const [poolSource, setPoolSource] = useState<"fresh" | "existing">("fresh");
  const [devnetPools, setDevnetPools] = useState<DevnetPool[] | null>(null);
  const [selectedPoolAddress, setSelectedPoolAddress] = useState<string>("");

  // ── Saved data ──
  const [commitment, setCommitment] = useState<Commitment | null>(null);
  const [depositResult, setDepositResult] = useState<{ leafIndex: number; signature: string } | null>(null);
  const [stealthWallet, setStealthWallet] = useState<StealthWallet | null>(null);
  const [proofResult, setProofResult] = useState<WithdrawProofResult | null>(null);
  const treeRef = useRef<MixerMerkleTree | null>(null);
  const [denomSol, setDenomSol] = useState<string | null>(null);

  const [pairConfig, setPairConfig] = useState<TestPairConfig | null>(null);
  const [positionPubkey, setPositionPubkey] = useState<string | null>(null);

  // ── Bootstrap ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { deposits } = (await apiGet("/mixer/deposits")) as { deposits: DepositSummary[] };
        const sorted = [...deposits].sort((a, b) => a.leafIndex - b.leafIndex);
        const tree = await createMixerMerkleTree(undefined, sorted.map((d) => BigInt(d.commitment)));
        if (!cancelled) treeRef.current = tree;
      } catch {
        const tree = await createMixerMerkleTree();
        if (!cancelled) treeRef.current = tree;
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await apiGet("/mixer/status");
        if (cancelled) return;
        if (status?.denomination) {
          setDenomSol((Number(BigInt(status.denomination)) / 1e9).toString());
        }
      } catch { /* pool may not be initialised yet */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const ensureTree = useCallback(async (): Promise<MixerMerkleTree> => {
    if (treeRef.current) return treeRef.current;
    const tree = await createMixerMerkleTree();
    treeRef.current = tree;
    return tree;
  }, []);

  // ═══════════════ Mixer steps (mirror MixerTestPage) ═══════════════

  const checkStatus = useCallback(async () => {
    setPoolStatus({ status: "loading" });
    try {
      const data = await apiGet("/mixer/status");
      setPoolStatus({ status: "success", data });
    } catch (err) {
      setPoolStatus({ status: "error", message: (err as Error).message });
    }
  }, []);

  const initializePool = useCallback(async () => {
    if (!wallet.address) return;
    setInitStep({ status: "loading", message: "Building tx..." });
    try {
      const { transaction, poolAddress } = await apiPost("/mixer/initialize", {
        authority: wallet.address,
      });
      setInitStep({ status: "loading", message: "Sign in your wallet..." });
      const sig = await signAndSendUser(transaction);
      setInitStep({ status: "success", message: "Pool initialized.", data: { poolAddress, signature: sig } });
    } catch (err) {
      setInitStep({ status: "error", message: (err as Error).message });
    }
  }, [wallet.address]);

  const genCommitment = useCallback(async () => {
    setCommitmentStep({ status: "loading", message: "Generating in browser..." });
    try {
      const c = await generateCommitment();
      setCommitment(c);
      setCommitmentStep({
        status: "success",
        data: { commitment: c.commitment.toString(), nullifierHash: c.nullifierHash.toString() },
      });
    } catch (err) {
      setCommitmentStep({ status: "error", message: (err as Error).message });
    }
  }, []);

  const deposit = useCallback(async () => {
    if (!wallet.address || !commitment) return;
    setDepositStep({ status: "loading", message: "Building deposit tx..." });
    try {
      const { transaction } = await apiPost("/mixer/deposit", {
        depositor: wallet.address,
        commitment: commitment.commitment.toString(),
      });
      setDepositStep({ status: "loading", message: "Sign in your wallet..." });
      const sig = await signAndSendUser(transaction);
      const status = await apiGet("/mixer/status");
      const leafIndex = (status?.nextLeafIndex ?? 1) - 1;
      const tree = await ensureTree();
      try { tree.insert(commitment.commitment); } catch { /* hydrated already */ }
      apiPost("/mixer/confirm-deposit", {
        commitment: commitment.commitment.toString(),
        leafIndex,
        txSignature: sig,
      }).catch(() => {});
      setDepositResult({ leafIndex, signature: sig });
      setDepositStep({ status: "success", data: { signature: sig, leafIndex } });
    } catch (err) {
      setDepositStep({ status: "error", message: (err as Error).message });
    }
  }, [wallet.address, commitment, ensureTree]);

  const genStealth = useCallback(() => {
    setStealthStep({ status: "loading", message: "Generating in browser..." });
    try {
      const w = generateStealthWallet();
      setStealthWallet(w);
      setStealthStep({ status: "success", data: { publicKey: w.publicKey } });
    } catch (err) {
      setStealthStep({ status: "error", message: (err as Error).message });
    }
  }, []);

  const genProof = useCallback(async () => {
    if (!commitment || !depositResult || !stealthWallet || !wallet.address) return;
    setProveStep({ status: "loading", message: "Generating ZK proof (~10–60s)…" });
    try {
      const tree = await ensureTree();
      const [recipientField, relayerField] = await Promise.all([
        pubkeyToFieldHash(new PublicKey(stealthWallet.publicKey)),
        pubkeyToFieldHash(new PublicKey(wallet.address)),
      ]);
      const inputs = buildWithdrawCircuitInput({
        tree, leafIndex: depositResult.leafIndex,
        secret: commitment.secret, nullifier: commitment.nullifier,
        nullifierHash: commitment.nullifierHash,
        recipientField, relayerField, fee: 0n,
      });
      const result = await generateWithdrawProof(inputs);
      setProofResult(result);
      setProveStep({ status: "success", data: { publicSignals: result.publicSignals } });
    } catch (err) {
      setProveStep({ status: "error", message: (err as Error).message });
    }
  }, [commitment, depositResult, stealthWallet, wallet.address, ensureTree]);

  const withdraw = useCallback(async () => {
    if (!proofResult || !stealthWallet || !wallet.address || !commitment) return;
    setWithdrawStep({ status: "loading", message: "Packing proof + building tx..." });
    try {
      const { transaction } = await apiPost("/mixer/withdraw", {
        signer: wallet.address,
        recipient: stealthWallet.publicKey,
        proofBytes: uint8ArrayToBase64(convertProofToBytes(proofResult.proof)),
        publicInputsBytes: uint8ArrayToBase64(convertPublicInputsToBytes(proofResult.publicSignals)),
        nullifierHash: commitment.nullifierHash.toString(),
      });
      setWithdrawStep({ status: "loading", message: "Sign in your wallet..." });
      const sig = await signAndSendUser(transaction);
      setWithdrawStep({ status: "success", data: { signature: sig } });
    } catch (err) {
      setWithdrawStep({ status: "error", message: (err as Error).message });
    }
  }, [proofResult, stealthWallet, wallet.address, commitment]);

  // ═══════════════ Executor steps ═══════════════

  const setupPair = useCallback(async () => {
    if (poolSource === "existing") {
      if (!selectedPoolAddress) {
        setSetupPairStep({ status: "error", message: "Pick a pool from the dropdown first." });
        return;
      }
      setSetupPairStep({
        status: "loading",
        message: "Loading on-chain pool state + initialising bin arrays...",
      });
      try {
        const config = (await apiPost("/executor/use-pool", {
          lbPair: selectedPoolAddress,
        })) as TestPairConfig;
        setPairConfig(config);
        setSetupPairStep({ status: "success", data: config });
      } catch (err) {
        setSetupPairStep({ status: "error", message: (err as Error).message });
      }
      return;
    }

    setSetupPairStep({
      status: "loading",
      message: "Server creating mints + LB pair + bin arrays (~10s)...",
    });
    try {
      const config = (await apiPost("/executor/setup-pair")) as TestPairConfig;
      setPairConfig(config);
      setSetupPairStep({ status: "success", data: config });
    } catch (err) {
      setSetupPairStep({ status: "error", message: (err as Error).message });
    }
  }, [poolSource, selectedPoolAddress]);

  const loadDevnetPools = useCallback(async () => {
    try {
      const { pools } = await apiGet("/executor/devnet-pools") as { pools: DevnetPool[] };
      setDevnetPools(pools);
      // Sensible default: first pool with non-zero reserves on both sides;
      // otherwise the first pool. Keeps add_liquidity less likely to fail.
      const liquid = pools.find((p) => p.reserveXAmount > 0 && p.reserveYAmount > 0);
      setSelectedPoolAddress((liquid ?? pools[0])?.address ?? "");
    } catch (err) {
      setSetupPairStep({
        status: "error",
        message: `Failed to load devnet pools: ${(err as Error).message}`,
      });
    }
  }, []);

  const mintTokens = useCallback(async () => {
    if (!pairConfig || !wallet.address) return;
    setMintTokensStep({ status: "loading", message: "Server minting test tokens..." });
    try {
      const result = await apiPost("/executor/mint-tokens", {
        owner: wallet.address,
        tokenX: pairConfig.tokenX,
        tokenY: pairConfig.tokenY,
        amountX: "1000000000",
        amountY: "1000000000",
      });
      setMintTokensStep({
        status: "success",
        message: "Minted 1k of each test token to your wallet.",
        data: result,
      });
    } catch (err) {
      setMintTokensStep({ status: "error", message: (err as Error).message });
    }
  }, [pairConfig, wallet.address]);

  const initPosition = useCallback(async () => {
    if (!pairConfig || !stealthWallet || !wallet.address) return;
    setInitPositionStep({ status: "loading", message: "Building init_position tx..." });
    try {
      const { transaction, positionPubkey } = await apiPost("/executor/init-position-tx", {
        stealth: stealthWallet.publicKey,
        lbPair: pairConfig.lbPair,
        // exit_recipient = the user's main wallet, so withdraw_close lands
        // back where the funds originated.
        exitRecipient: wallet.address,
        lowerBinId: pairConfig.lowerBinId,
        width: pairConfig.width,
      });
      setInitPositionStep({ status: "loading", message: "Stealth keypair signing..." });
      const sig = await signAndSendStealth({ txBase64: transaction, stealth: stealthWallet });
      setPositionPubkey(positionPubkey);
      setInitPositionStep({
        status: "success",
        data: { signature: sig, positionPubkey },
      });
    } catch (err) {
      setInitPositionStep({ status: "error", message: (err as Error).message });
    }
  }, [pairConfig, stealthWallet, wallet.address]);

  const addLiquidity = useCallback(async () => {
    if (!pairConfig || !stealthWallet || !wallet.address) return;
    setAddLiquidityStep({ status: "loading", message: "Building add_liquidity tx..." });
    try {
      const { transaction } = await apiPost("/executor/add-liquidity-tx", {
        stealth: stealthWallet.publicKey,
        userOwner: wallet.address,
        config: pairConfig,
        amountX: "100",
        amountY: "100",
      });
      setAddLiquidityStep({ status: "loading", message: "Stealth + your wallet signing..." });
      const sig = await signAndSendStealth({
        txBase64: transaction,
        stealth: stealthWallet,
        alsoSignWithUserWallet: true,
      });
      setAddLiquidityStep({ status: "success", data: { signature: sig } });
    } catch (err) {
      setAddLiquidityStep({ status: "error", message: (err as Error).message });
    }
  }, [pairConfig, stealthWallet, wallet.address]);

  const withdrawClose = useCallback(async () => {
    if (!pairConfig || !stealthWallet || !wallet.address) return;
    setWithdrawCloseStep({ status: "loading", message: "Building withdraw_close tx..." });
    try {
      const { transaction } = await apiPost("/executor/withdraw-close-tx", {
        stealth: stealthWallet.publicKey,
        exitRecipient: wallet.address,
        config: pairConfig,
      });
      setWithdrawCloseStep({ status: "loading", message: "Stealth signing..." });
      const sig = await signAndSendStealth({ txBase64: transaction, stealth: stealthWallet });
      setWithdrawCloseStep({ status: "success", data: { signature: sig } });
    } catch (err) {
      setWithdrawCloseStep({ status: "error", message: (err as Error).message });
    }
  }, [pairConfig, stealthWallet, wallet.address]);

  // ── Render ──

  if (!wallet.connected) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold">Integrated Test</h1>
          <p className="text-muted-foreground">Connect your wallet to start</p>
          <button
            onClick={connect}
            className="px-6 py-3 bg-primary text-primary-foreground rounded-lg font-medium hover:opacity-90"
          >
            Connect Wallet
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Integrated Test: Mixer → Stealth → Executor</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Wallet: {wallet.address?.slice(0, 8)}...{wallet.address?.slice(-4)}
        </p>
        <p className="text-xs text-muted-foreground">
          All secrets and stealth signing happen in your browser — the server never sees your stealth keypair.
        </p>
      </div>

      <div className="text-xs uppercase tracking-wide text-muted-foreground border-b border-border pb-1">
        Phase 1 — Mixer
      </div>

      <StepCard number={0} title="Check Pool Status" state={poolStatus} onAction={checkStatus} actionLabel="Check Status" />
      <StepCard
        number={1}
        title="Initialize Pool (one-time)"
        description={`Creates a ${denomSol ?? "?"} SOL denomination pool`}
        state={initStep} onAction={initializePool} actionLabel="Initialize"
      />
      <StepCard
        number={2}
        title="Generate Commitment (browser)"
        description="secret + nullifier → commitment hash"
        state={commitmentStep} onAction={genCommitment} actionLabel="Generate"
      />
      <StepCard
        number={3} title={`Deposit ${denomSol ?? "?"} SOL`}
        state={depositStep} onAction={deposit} actionLabel="Deposit"
        disabled={!commitment}
      />
      <StepCard
        number={4} title="Generate Stealth Wallet (browser)"
        description="Random ed25519 keypair, kept in browser memory"
        state={stealthStep} onAction={genStealth} actionLabel="Generate Stealth"
        disabled={depositStep.status !== "success"}
      />
      <StepCard
        number={5} title="Generate ZK Proof (browser)"
        description="snarkjs.groth16.fullProve runs locally — secrets never leave"
        state={proveStep} onAction={genProof} actionLabel="Generate Proof"
        disabled={!stealthWallet || depositStep.status !== "success"}
      />
      <StepCard
        number={6} title="Withdraw to Stealth Wallet"
        description={`${denomSol ?? "?"} SOL → stealth address`}
        state={withdrawStep} onAction={withdraw} actionLabel="Withdraw"
        disabled={!proofResult}
      />

      <div className="text-xs uppercase tracking-wide text-muted-foreground border-b border-border pb-1 pt-4">
        Phase 2 — Executor (DLMM via stealth)
      </div>

      <div className="border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">Pool source</h3>
          <div className="flex gap-2 text-xs">
            <button
              onClick={() => setPoolSource("fresh")}
              className={`px-3 py-1 rounded-md border ${
                poolSource === "fresh"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              Create fresh
            </button>
            <button
              onClick={() => {
                setPoolSource("existing");
                if (!devnetPools) void loadDevnetPools();
              }}
              className={`px-3 py-1 rounded-md border ${
                poolSource === "existing"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              Pick devnet pool
            </button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {poolSource === "fresh"
            ? "Server creates two new SPL mints, a fresh LB pair, and the bin arrays — slow (~10s) but you control both sides."
            : "Pick an existing pool from Meteora's devnet API. Init position works without funding; add_liquidity needs balance in both mints."}
        </p>
        {poolSource === "existing" && (
          <div className="space-y-2">
            {devnetPools === null ? (
              <p className="text-xs text-muted-foreground">Loading pools…</p>
            ) : devnetPools.length === 0 ? (
              <p className="text-xs text-red-400">No pools returned by Meteora devnet API.</p>
            ) : (
              <select
                value={selectedPoolAddress}
                onChange={(e) => setSelectedPoolAddress(e.target.value)}
                className="w-full bg-card border border-border rounded-md px-2 py-1.5 text-xs"
              >
                {devnetPools.map((p) => (
                  <option key={p.address} value={p.address}>
                    {p.name} • binStep {p.binStep} •{" "}
                    {p.reserveXAmount > 0 && p.reserveYAmount > 0 ? "liquid" : "empty"} •{" "}
                    {p.address.slice(0, 8)}…
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={loadDevnetPools}
              className="text-xs text-primary hover:underline"
            >
              Refresh pool list
            </button>
          </div>
        )}
      </div>

      <StepCard
        number={7}
        title={poolSource === "fresh" ? "Setup Test LB Pair (server admin)" : "Use Selected Devnet Pool"}
        description={
          poolSource === "fresh"
            ? "Server creates 2 SPL mints + DLMM LB pair + bin arrays"
            : "Reads on-chain pool state, initialises bin arrays around active bin"
        }
        state={setupPairStep} onAction={setupPair} actionLabel={poolSource === "fresh" ? "Setup Pair" : "Use Pool"}
        disabled={withdrawStep.status !== "success" || (poolSource === "existing" && !selectedPoolAddress)}
      />
      <StepCard
        number={8}
        title="Mint Test Tokens to Your Wallet"
        description={
          poolSource === "fresh"
            ? "1k of each test token, used as add_liquidity input"
            : "Server is the mint authority only for fresh pairs. For an existing devnet pool, you'll need to fund the two mints yourself (or skip add_liquidity)."
        }
        state={mintTokensStep} onAction={mintTokens} actionLabel="Mint"
        disabled={!pairConfig || poolSource !== "fresh"}
      />
      <StepCard
        number={9} title="Init Position (stealth signs via executor)"
        description="Creates a DLMM position whose owner is the PositionAuthority PDA"
        state={initPositionStep} onAction={initPosition} actionLabel="Init Position"
        disabled={
          !pairConfig ||
          !stealthWallet ||
          // For fresh pairs we wait for the mint step; for existing pools
          // there's nothing to mint, so the pair config alone is enough.
          (poolSource === "fresh" && mintTokensStep.status !== "success")
        }
      />
      <StepCard
        number={10} title="Add Liquidity (your wallet + stealth co-sign)"
        description="100 X + 100 Y escrowed via PDA ATA, then deposited into the position"
        state={addLiquidityStep} onAction={addLiquidity} actionLabel="Add Liquidity"
        disabled={!positionPubkey}
      />
      <StepCard
        number={11} title="Withdraw Close (stealth signs)"
        description="Tokens flow back to your wallet (exit_recipient) and the position closes"
        state={withdrawCloseStep} onAction={withdrawClose} actionLabel="Withdraw + Close"
        disabled={addLiquidityStep.status !== "success"}
      />

      {withdrawCloseStep.status === "success" && stealthWallet && (
        <div className="border border-primary/30 bg-primary/5 rounded-lg p-4 space-y-2">
          <h3 className="font-bold text-primary">Full Cycle Complete</h3>
          <p className="text-sm">
            SOL was mixer-deposited and withdrawn to a stealth wallet, which then opened a DLMM
            position via the executor and exited back to your main wallet.
          </p>
          <p className="text-xs text-muted-foreground">
            Stealth wallet that signed the executor flow: <code className="text-foreground">{stealthWallet.publicKey}</code>
          </p>
        </div>
      )}
    </div>
  );
}

function StepCard({
  number, title, description, state, onAction, actionLabel, disabled,
}: {
  number: number; title: string; description?: string;
  state: StepState; onAction: () => void; actionLabel: string; disabled?: boolean;
}) {
  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">
            <span className="text-muted-foreground mr-2">#{number}</span>
            {title}
            {state.status === "success" && <span className="ml-2 text-green-400">✓</span>}
            {state.status === "error" && <span className="ml-2 text-red-400">✗</span>}
          </h3>
          {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
        </div>
        <button
          onClick={onAction}
          disabled={disabled || state.status === "loading"}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {state.status === "loading" ? "..." : actionLabel}
        </button>
      </div>
      {state.status === "loading" && state.message && (
        <p className="text-xs text-yellow-400">{state.message}</p>
      )}
      {state.status === "error" && (
        <p className="text-xs text-red-400 break-all">{state.message}</p>
      )}
      {state.status === "success" && state.data !== undefined && (
        <pre className="text-xs bg-card p-2 rounded overflow-x-auto max-h-32 text-muted-foreground">
          {JSON.stringify(state.data, null, 2)}
        </pre>
      )}
      {state.status === "success" && state.message && (
        <p className="text-xs text-green-400">{state.message}</p>
      )}
    </div>
  );
}
