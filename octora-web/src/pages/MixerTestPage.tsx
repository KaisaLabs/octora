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
// Default devnet — override with VITE_RPC_URL for localnet runs.
const RPC_URL =
  import.meta.env.VITE_RPC_URL ?? "https://api.devnet.solana.com";

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

  const txBytes = Uint8Array.from(atob(txBase64), (c) => c.charCodeAt(0));
  const tx = Transaction.from(txBytes);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  const balance = await connection.getBalance(tx.feePayer!);
  if (balance === 0) {
    throw new Error(
      `Wallet ${tx.feePayer!.toBase58()} has 0 SOL on ${RPC_URL}. ` +
        `Make sure your wallet is set to the correct network and has SOL.`,
    );
  }

  const signed = await provider.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}

interface DepositSummary {
  commitment: string;
  leafIndex: number;
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

  // Saved data between steps. All secret material stays in component state /
  // refs and is never sent to the server.
  const [commitment, setCommitment] = useState<Commitment | null>(null);
  const [depositResult, setDepositResult] = useState<{
    leafIndex: number;
    signature: string;
  } | null>(null);
  const [stealthWallet, setStealthWallet] = useState<StealthWallet | null>(null);
  const [proofResult, setProofResult] = useState<WithdrawProofResult | null>(null);
  const treeRef = useRef<MixerMerkleTree | null>(null);

  // Pool denomination, in SOL, learned from /mixer/status. Used for step
  // labels so the UI never lies about how much is being deposited /
  // withdrawn — the on-chain denomination is the source of truth.
  const [denomSol, setDenomSol] = useState<string | null>(null);

  // Bootstrap: fetch existing deposits from the API and rebuild the tree
  // locally so we can compute correct merkle paths/roots. The API only
  // exposes the public history (commitments + leaf indices) — never anything
  // secret.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { deposits } = (await apiGet("/mixer/deposits")) as {
          deposits: DepositSummary[];
        };
        const sorted = [...deposits].sort((a, b) => a.leafIndex - b.leafIndex);
        const tree = await createMixerMerkleTree(
          undefined,
          sorted.map((d) => BigInt(d.commitment)),
        );
        if (!cancelled) {
          treeRef.current = tree;
        }
      } catch {
        // Empty / not-yet-initialised pool is fine — build an empty tree.
        const tree = await createMixerMerkleTree();
        if (!cancelled) treeRef.current = tree;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Pull the live pool denomination so step labels display the actual amount
  // every deposit/withdrawal moves. The default denomination is set by the
  // API's MIXER_DENOMINATION env var (0.02 SOL) and frozen at pool init.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await apiGet("/mixer/status");
        if (cancelled) return;
        if (status?.denomination) {
          const lamports = BigInt(status.denomination);
          // 1 SOL = 1e9 lamports. Render with up to 9 decimals, trimmed.
          const sol = (Number(lamports) / 1e9).toString();
          setDenomSol(sol);
        }
      } catch {
        // Pool may not be initialised yet — leave label as a placeholder.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const ensureTree = useCallback(async (): Promise<MixerMerkleTree> => {
    if (treeRef.current) return treeRef.current;
    const tree = await createMixerMerkleTree();
    treeRef.current = tree;
    return tree;
  }, []);

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
        message: "Pool initialized!",
        data: { poolAddress, signature: sig },
      });
    } catch (err: any) {
      setInitStep({ status: "error", message: err.message });
    }
  }, [wallet.address]);

  // ── Step 2: Generate commitment (BROWSER-SIDE) ──
  const genCommitment = useCallback(async () => {
    setCommitmentStep({ status: "loading", message: "Generating in browser..." });
    try {
      const c = await generateCommitment();
      setCommitment(c);
      setCommitmentStep({
        status: "success",
        // Only public values are surfaced; secret/nullifier are kept in state.
        data: {
          commitment: c.commitment.toString(),
          nullifierHash: c.nullifierHash.toString(),
          note: "Secret + nullifier kept in browser memory only.",
        },
      });
    } catch (err: any) {
      setCommitmentStep({ status: "error", message: err.message });
    }
  }, []);

  // ── Step 3: Deposit ──
  // The on-chain program now computes the new Merkle root deterministically
  // from its filled_subtrees cache, so the browser doesn't need to insert
  // into the local tree before submitting. We learn the assigned leaf index
  // by reading the post-confirmation pool state.
  const deposit = useCallback(async () => {
    if (!wallet.address || !commitment) return;
    setDepositStep({ status: "loading", message: "Building deposit transaction..." });
    try {
      const { transaction } = await apiPost("/mixer/deposit", {
        depositor: wallet.address,
        commitment: commitment.commitment.toString(),
      });

      setDepositStep({ status: "loading", message: "Sign the deposit in your wallet..." });
      const sig = await signAndSend(transaction);

      // The program assigns leaf_index = pool.next_leaf_index at insert time
      // and increments. Read the post-confirmation pool state to learn the
      // index this deposit got. We use it later for proof generation.
      const status = await apiGet("/mixer/status");
      const leafIndex = (status?.nextLeafIndex ?? 1) - 1;

      // Mirror it into the local tree so withdrawal-time path lookup works
      // without re-fetching everything.
      const tree = await ensureTree();
      try {
        tree.insert(commitment.commitment);
      } catch {
        // Tree already had this commitment from /mixer/deposits hydration —
        // ignore.
      }

      // Tell the API to record this deposit so future users get the right tree.
      // Best-effort — even if this fails, the on-chain tx already landed.
      apiPost("/mixer/confirm-deposit", {
        commitment: commitment.commitment.toString(),
        leafIndex,
        txSignature: sig,
      }).catch(() => {});

      setDepositResult({ leafIndex, signature: sig });
      setDepositStep({
        status: "success",
        message: "Deposit confirmed on-chain.",
        data: { signature: sig, leafIndex },
      });
    } catch (err: any) {
      setDepositStep({ status: "error", message: err.message });
    }
  }, [wallet.address, commitment, ensureTree]);

  // ── Step 4: Generate stealth wallet (BROWSER-SIDE) ──
  const genStealth = useCallback(() => {
    setStealthStep({ status: "loading", message: "Generating in browser..." });
    try {
      const w = generateStealthWallet();
      setStealthWallet(w);
      setStealthStep({
        status: "success",
        // Never surface the secret key in the UI summary.
        data: {
          publicKey: w.publicKey,
          note: "Private key kept in browser memory only.",
        },
      });
    } catch (err: any) {
      setStealthStep({ status: "error", message: err.message });
    }
  }, []);

  // ── Step 5: Generate ZK proof (BROWSER-SIDE) ──
  const genProof = useCallback(async () => {
    if (!commitment || !depositResult || !stealthWallet || !wallet.address) return;
    setProveStep({
      status: "loading",
      message: "Generating ZK proof in browser… (~10–60s, do not close tab)",
    });
    try {
      const tree = await ensureTree();

      const [recipientField, relayerField] = await Promise.all([
        pubkeyToFieldHash(new PublicKey(stealthWallet.publicKey)),
        pubkeyToFieldHash(new PublicKey(wallet.address)),
      ]);

      const inputs = buildWithdrawCircuitInput({
        tree,
        leafIndex: depositResult.leafIndex,
        secret: commitment.secret,
        nullifier: commitment.nullifier,
        nullifierHash: commitment.nullifierHash,
        recipientField,
        relayerField,
        fee: 0n,
      });

      const result = await generateWithdrawProof(inputs);
      setProofResult(result);
      setProveStep({
        status: "success",
        message: "Proof generated locally.",
        data: { publicSignals: result.publicSignals },
      });
    } catch (err: any) {
      setProveStep({ status: "error", message: err.message });
    }
  }, [commitment, depositResult, stealthWallet, wallet.address, ensureTree]);

  // ── Step 6: Withdraw ──
  const withdraw = useCallback(async () => {
    if (!proofResult || !stealthWallet || !wallet.address || !commitment) return;
    setWithdrawStep({ status: "loading", message: "Packing proof + building tx..." });
    try {
      const proofBytes = uint8ArrayToBase64(convertProofToBytes(proofResult.proof));
      const publicInputsBytes = uint8ArrayToBase64(
        convertPublicInputsToBytes(proofResult.publicSignals),
      );

      const { transaction } = await apiPost("/mixer/withdraw", {
        signer: wallet.address,
        recipient: stealthWallet.publicKey,
        proofBytes,
        publicInputsBytes,
        nullifierHash: commitment.nullifierHash.toString(),
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
          All secrets, stealth keys, and proofs are generated in your browser.
        </p>
      </div>

      <StepCard
        number={0}
        title="Check Pool Status"
        state={poolStatus}
        onAction={checkStatus}
        actionLabel="Check Status"
      />
      <StepCard
        number={1}
        title="Initialize Pool (one-time)"
        description={`Creates a ${denomSol ?? "?"} SOL denomination pool on-chain`}
        state={initStep}
        onAction={initializePool}
        actionLabel="Initialize Pool"
      />
      <StepCard
        number={2}
        title="Generate Commitment (browser)"
        description="secret + nullifier → commitment hash, in your browser"
        state={commitmentStep}
        onAction={genCommitment}
        actionLabel="Generate"
      />
      <StepCard
        number={3}
        title={`Deposit ${denomSol ?? "?"} SOL`}
        description="Sends SOL to the mixer pool with your commitment"
        state={depositStep}
        onAction={deposit}
        actionLabel="Deposit"
        disabled={!commitment}
      />
      <StepCard
        number={4}
        title="Generate Stealth Wallet (browser)"
        description="Random ed25519 keypair, kept entirely in browser memory"
        state={stealthStep}
        onAction={genStealth}
        actionLabel="Generate Stealth"
        disabled={depositStep.status !== "success"}
      />
      <StepCard
        number={5}
        title="Generate ZK Proof (browser)"
        description="snarkjs.groth16.fullProve runs locally — secrets never leave"
        state={proveStep}
        onAction={genProof}
        actionLabel="Generate Proof"
        disabled={!stealthWallet || depositStep.status !== "success"}
      />
      <StepCard
        number={6}
        title="Withdraw to Stealth Wallet"
        description={`Sends ${denomSol ?? "?"} SOL from the pool to your stealth wallet`}
        state={withdrawStep}
        onAction={withdraw}
        actionLabel="Withdraw"
        disabled={!proofResult}
      />

      {withdrawStep.status === "success" && stealthWallet && (
        <div className="border border-primary/30 bg-primary/5 rounded-lg p-4 space-y-2">
          <h3 className="font-bold text-primary">Flow Complete!</h3>
          <p className="text-sm">Your SOL has been privately transferred to a stealth wallet.</p>
          <div className="text-xs text-muted-foreground space-y-1">
            <p>
              Stealth address: <code className="text-foreground">{stealthWallet.publicKey}</code>
            </p>
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
