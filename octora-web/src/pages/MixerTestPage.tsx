import { useState, useCallback } from "react";
import { useSolana } from "@/providers/SolanaProvider";
import { Connection, Transaction } from "@solana/web3.js";

const API = import.meta.env.VITE_API_URL ?? "/api";
const RPC_URL = "http://localhost:8899";

interface StepState {
  status: "idle" | "loading" | "success" | "error";
  message?: string;
  data?: any;
}

async function apiPost(path: string, body?: any) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiGet(path: string) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Sign and send a base64-encoded transaction via the browser wallet.
 * Refreshes the blockhash to avoid "Blockhash not found" errors,
 * then sends via the same RPC the API uses.
 */
async function signAndSend(txBase64: string): Promise<string> {
  const provider = (window as any).solana;
  if (!provider) throw new Error("No Solana wallet found");

  const connection = new Connection(RPC_URL, "confirmed");

  // Deserialize the transaction from the API
  const txBytes = Uint8Array.from(atob(txBase64), (c) => c.charCodeAt(0));
  const tx = Transaction.from(txBytes);

  // Replace with a fresh blockhash from the same RPC
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  // Verify the feePayer has balance on this RPC
  const balance = await connection.getBalance(tx.feePayer!);
  if (balance === 0) {
    throw new Error(
      `Wallet ${tx.feePayer!.toBase58()} has 0 SOL on ${RPC_URL}. ` +
      `Make sure your wallet is set to the correct network and has SOL.`
    );
  }

  // Sign with the wallet
  const signed = await provider.signTransaction(tx);

  // Send via the same RPC (not the wallet's default RPC)
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  // Wait for confirmation
  await connection.confirmTransaction({
    signature: sig,
    blockhash,
    lastValidBlockHeight,
  }, "confirmed");

  return sig;
}

export function MixerTestPage() {
  const { wallet, connect } = useSolana();

  const [poolStatus, setPoolStatus] = useState<StepState>({ status: "idle" });
  const [initStep, setInitStep] = useState<StepState>({ status: "idle" });
  const [commitmentStep, setCommitmentStep] = useState<StepState>({ status: "idle" });
  const [depositStep, setDepositStep] = useState<StepState>({ status: "idle" });
  const [stealthStep, setStealthStep] = useState<StepState>({ status: "idle" });
  const [proveStep, setProveStep] = useState<StepState>({ status: "idle" });
  const [withdrawStep, setWithdrawStep] = useState<StepState>({ status: "idle" });

  // Saved data between steps
  const [commitment, setCommitment] = useState<any>(null);
  const [depositResult, setDepositResult] = useState<any>(null);
  const [stealthWallet, setStealthWallet] = useState<any>(null);
  const [proofResult, setProofResult] = useState<any>(null);

  // ── Step 0: Check pool status ──
  const checkStatus = useCallback(async () => {
    setPoolStatus({ status: "loading" });
    try {
      const data = await apiGet("/mixer/status");
      setPoolStatus({ status: "success", data });
    } catch (err: any) {
      setPoolStatus({ status: "error", message: err.message });
    }
  }, []);

  // ── Step 1: Initialize pool ──
  const initializePool = useCallback(async () => {
    if (!wallet.address) return;
    setInitStep({ status: "loading", message: "Building transaction..." });
    try {
      const { transaction, poolAddress } = await apiPost("/mixer/initialize", {
        authority: wallet.address,
      });
      setInitStep({ status: "loading", message: "Sign the transaction in your wallet..." });
      const sig = await signAndSend(transaction);
      setInitStep({
        status: "success",
        message: `Pool initialized!`,
        data: { poolAddress, signature: sig },
      });
    } catch (err: any) {
      setInitStep({ status: "error", message: err.message });
    }
  }, [wallet.address]);

  // ── Step 2: Generate commitment ──
  const genCommitment = useCallback(async () => {
    setCommitmentStep({ status: "loading" });
    try {
      const data = await apiGet("/mixer/commitment");
      setCommitment(data);
      setCommitmentStep({ status: "success", data });
    } catch (err: any) {
      setCommitmentStep({ status: "error", message: err.message });
    }
  }, []);

  // ── Step 3: Deposit ──
  const deposit = useCallback(async () => {
    if (!wallet.address || !commitment) return;
    setDepositStep({ status: "loading", message: "Building deposit transaction..." });
    try {
      const result = await apiPost("/mixer/deposit", {
        depositor: wallet.address,
        commitment: commitment.commitment,
      });
      setDepositStep({ status: "loading", message: "Sign the deposit in your wallet..." });
      const sig = await signAndSend(result.transaction);
      setDepositResult({ ...result, signature: sig });
      setDepositStep({
        status: "success",
        message: "Deposited 0.01 SOL into mixer!",
        data: { signature: sig, leafIndex: result.leafIndex },
      });
    } catch (err: any) {
      setDepositStep({ status: "error", message: err.message });
    }
  }, [wallet.address, commitment]);

  // ── Step 4: Generate stealth wallet ──
  const genStealth = useCallback(async () => {
    setStealthStep({ status: "loading" });
    try {
      const data = await apiGet("/mixer/stealth-wallet");
      setStealthWallet(data);
      setStealthStep({ status: "success", data });
    } catch (err: any) {
      setStealthStep({ status: "error", message: err.message });
    }
  }, []);

  // ── Step 5: Generate ZK proof ──
  const genProof = useCallback(async () => {
    if (!commitment || !depositResult || !stealthWallet || !wallet.address) return;
    setProveStep({ status: "loading", message: "Generating ZK proof... (may take 10-30s)" });
    try {
      const data = await apiPost("/mixer/prove", {
        secret: commitment.secret,
        nullifier: commitment.nullifier,
        leafIndex: depositResult.leafIndex,
        recipient: stealthWallet.publicKey,
        relayer: wallet.address,
        fee: "0",
      });
      setProofResult(data);
      setProveStep({ status: "success", message: "Proof generated!", data });
    } catch (err: any) {
      setProveStep({ status: "error", message: err.message });
    }
  }, [commitment, depositResult, stealthWallet, wallet.address]);

  // ── Step 6: Withdraw ──
  const withdraw = useCallback(async () => {
    if (!proofResult || !stealthWallet || !wallet.address || !commitment) return;
    setWithdrawStep({ status: "loading", message: "Building withdraw transaction..." });
    try {
      const { transaction } = await apiPost("/mixer/withdraw", {
        signer: wallet.address,
        recipient: stealthWallet.publicKey,
        proofBytes: proofResult.proofBytes,
        publicInputsBytes: proofResult.publicInputsBytes,
        nullifierHash: commitment.nullifierHash,
      });
      setWithdrawStep({ status: "loading", message: "Sign the withdrawal in your wallet..." });
      const sig = await signAndSend(transaction);
      setWithdrawStep({
        status: "success",
        message: "Withdrawn to stealth wallet!",
        data: { signature: sig },
      });
    } catch (err: any) {
      setWithdrawStep({ status: "error", message: err.message });
    }
  }, [proofResult, stealthWallet, wallet.address, commitment]);

  // ── Render ──

  if (!wallet.connected) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold">Mixer Test</h1>
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
        <h1 className="text-2xl font-bold">Mixer Test Flow</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Wallet: {wallet.address?.slice(0, 8)}...{wallet.address?.slice(-4)}
        </p>
        <p className="text-xs text-muted-foreground">
          Flow: Your Wallet → Mixer Pool → ZK Proof → Stealth Wallet
        </p>
      </div>

      {/* Pool Status */}
      <StepCard
        number={0}
        title="Check Pool Status"
        state={poolStatus}
        onAction={checkStatus}
        actionLabel="Check Status"
      />

      {/* Initialize */}
      <StepCard
        number={1}
        title="Initialize Pool (one-time)"
        description="Creates a 0.01 SOL denomination pool on-chain"
        state={initStep}
        onAction={initializePool}
        actionLabel="Initialize Pool"
      />

      {/* Generate Commitment */}
      <StepCard
        number={2}
        title="Generate Commitment"
        description="Creates secret + nullifier → commitment hash"
        state={commitmentStep}
        onAction={genCommitment}
        actionLabel="Generate"
      />

      {/* Deposit */}
      <StepCard
        number={3}
        title="Deposit 0.01 SOL"
        description="Sends SOL to the mixer pool with your commitment"
        state={depositStep}
        onAction={deposit}
        actionLabel="Deposit"
        disabled={!commitment}
      />

      {/* Stealth Wallet */}
      <StepCard
        number={4}
        title="Generate Stealth Wallet"
        description="Creates a random wallet with no link to yours"
        state={stealthStep}
        onAction={genStealth}
        actionLabel="Generate Stealth"
        disabled={depositStep.status !== "success"}
      />

      {/* Generate Proof */}
      <StepCard
        number={5}
        title="Generate ZK Proof"
        description="Proves you deposited without revealing which deposit is yours"
        state={proveStep}
        onAction={genProof}
        actionLabel="Generate Proof"
        disabled={!stealthWallet || depositStep.status !== "success"}
      />

      {/* Withdraw */}
      <StepCard
        number={6}
        title="Withdraw to Stealth Wallet"
        description="Sends 0.01 SOL from the pool to your stealth wallet"
        state={withdrawStep}
        onAction={withdraw}
        actionLabel="Withdraw"
        disabled={!proofResult}
      />

      {/* Result */}
      {withdrawStep.status === "success" && stealthWallet && (
        <div className="border border-primary/30 bg-primary/5 rounded-lg p-4 space-y-2">
          <h3 className="font-bold text-primary">Flow Complete!</h3>
          <p className="text-sm">Your SOL has been privately transferred to a stealth wallet.</p>
          <div className="text-xs text-muted-foreground space-y-1">
            <p>Stealth address: <code className="text-foreground">{stealthWallet.publicKey}</code></p>
            <p>
              <a
                href={`https://explorer.solana.com/address/${stealthWallet.publicKey}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                View on Solana Explorer →
              </a>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Step Card Component ──

function StepCard({
  number,
  title,
  description,
  state,
  onAction,
  actionLabel,
  disabled,
}: {
  number: number;
  title: string;
  description?: string;
  state: StepState;
  onAction: () => void;
  actionLabel: string;
  disabled?: boolean;
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
          {description && (
            <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
          )}
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

      {state.status === "success" && state.data && (
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
