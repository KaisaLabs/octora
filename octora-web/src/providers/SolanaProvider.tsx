import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import type { Address, Lamports } from "@solana/kit";
import { createSolanaClient, getLamportBalance, type SolanaClient } from "@/lib/solana/client";

/* ─────────────────────────────────────────────────────────
 * SolanaProvider — React context for Solana client + wallet
 *
 * Provides:
 *   - RPC / WebSocket sub client
 *   - Wallet connection state (address, connected, connecting)
 *   - Balance (lamports, auto-refreshed every 15s)
 *   - connect / disconnect callbacks
 * ───────────────────────────────────────────────────────── */

interface WalletState {
  address: Address | null;
  connected: boolean;
  connecting: boolean;
}

interface SolanaContextValue {
  client: SolanaClient;
  wallet: WalletState;
  balance: Lamports | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  refreshBalance: () => Promise<void>;
}

const SolanaContext = createContext<SolanaContextValue | null>(null);

export function SolanaProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => createSolanaClient("devnet"));
  const [wallet, setWallet] = useState<WalletState>({
    address: null,
    connected: false,
    connecting: false,
  });
  const [balance, setBalance] = useState<Lamports | null>(null);

  const connect = useCallback(async () => {
    setWallet((w) => ({ ...w, connecting: true }));
    try {
      const provider = (window as unknown as Record<string, unknown>).solana as
        | { connect(): Promise<{ publicKey: { toString(): string } }>; disconnect(): Promise<void> }
        | undefined;

      if (!provider) {
        alert("No Solana wallet found. Please install Phantom or Backpack.");
        setWallet((w) => ({ ...w, connecting: false }));
        return;
      }

      const resp = await provider.connect();
      const pubkey = resp.publicKey.toString();

      setWallet({
        address: pubkey as Address,
        connected: true,
        connecting: false,
      });
    } catch (err) {
      console.error("Wallet connection failed:", err);
      setWallet({ address: null, connected: false, connecting: false });
    }
  }, []);

  const disconnect = useCallback(() => {
    const provider = (window as unknown as Record<string, unknown>).solana as
      | { disconnect(): Promise<void> }
      | undefined;

    provider?.disconnect().catch(() => {});
    setWallet({ address: null, connected: false, connecting: false });
    setBalance(null);
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!wallet.address) return;
    try {
      const lamports = await getLamportBalance(client.rpc, wallet.address);
      setBalance(lamports);
    } catch {
      // silently fail
    }
  }, [client.rpc, wallet.address]);

  // Auto-refresh every 15s while connected
  useEffect(() => {
    if (wallet.connected && wallet.address) {
      refreshBalance();
      const interval = setInterval(refreshBalance, 15_000);
      return () => clearInterval(interval);
    }
  }, [wallet.connected, wallet.address, refreshBalance]);

  // Auto-connect if previously authorized
  useEffect(() => {
    const provider = (window as unknown as Record<string, unknown>).solana as
      | { connect(opts: { onlyIfTrusted: boolean }): Promise<{ publicKey: { toString(): string } }> }
      | undefined;

    if (provider) {
      provider.connect({ onlyIfTrusted: true }).then((resp) => {
        setWallet({
          address: resp.publicKey.toString() as Address,
          connected: true,
          connecting: false,
        });
      }).catch(() => {
        // Not previously authorized — ok
      });
    }
  }, []);

  return (
    <SolanaContext.Provider
      value={{ client, wallet, balance, connect, disconnect, refreshBalance }}
    >
      {children}
    </SolanaContext.Provider>
  );
}

export function useSolana() {
  const ctx = useContext(SolanaContext);
  if (!ctx) throw new Error("useSolana must be used within SolanaProvider");
  return ctx;
}
