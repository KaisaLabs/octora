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
 *   - Wallet connection state (address, connected, connecting, providerId)
 *   - Balance (lamports, auto-refreshed every 15s)
 *   - connect(providerId?) / disconnect callbacks
 * ───────────────────────────────────────────────────────── */

export type WalletProviderId = "phantom" | "solflare" | "backpack";

export interface WalletProviderInfo {
  id: WalletProviderId;
  name: string;
  /** True if the browser exposes the provider object. */
  installed: boolean;
  /** Where to install the wallet if missing. */
  installUrl: string;
}

interface WalletState {
  address: Address | null;
  connected: boolean;
  connecting: boolean;
  /** Which wallet the user is currently connected through. */
  providerId: WalletProviderId | null;
}

interface PhantomLikeProvider {
  isPhantom?: boolean;
  isBackpack?: boolean;
  isSolflare?: boolean;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString(): string } }>;
  disconnect: () => Promise<void>;
}

interface SolanaContextValue {
  client: SolanaClient;
  wallet: WalletState;
  balance: Lamports | null;
  /** List of detected/known wallet providers (always returns the canonical 3). */
  providers: WalletProviderInfo[];
  connect: (providerId?: WalletProviderId) => Promise<void>;
  disconnect: () => void;
  refreshBalance: () => Promise<void>;
}

const SolanaContext = createContext<SolanaContextValue | null>(null);

const KNOWN_PROVIDERS: Array<Omit<WalletProviderInfo, "installed">> = [
  { id: "phantom", name: "Phantom", installUrl: "https://phantom.app/download" },
  { id: "solflare", name: "Solflare", installUrl: "https://solflare.com/download" },
  { id: "backpack", name: "Backpack", installUrl: "https://backpack.app/download" },
];

/** Look up the injected provider for a given wallet id. */
function getInjectedProvider(id: WalletProviderId): PhantomLikeProvider | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as Record<string, unknown>;

  if (id === "phantom") {
    const phantom = (w["phantom"] as Record<string, unknown> | undefined)?.["solana"] as
      | PhantomLikeProvider
      | undefined;
    if (phantom?.isPhantom) return phantom;
    const fallback = w["solana"] as PhantomLikeProvider | undefined;
    return fallback?.isPhantom ? fallback : undefined;
  }
  if (id === "solflare") {
    return w["solflare"] as PhantomLikeProvider | undefined;
  }
  if (id === "backpack") {
    return (w["backpack"] as { solana?: PhantomLikeProvider } | undefined)?.solana;
  }
  return undefined;
}

function detectProviders(): WalletProviderInfo[] {
  return KNOWN_PROVIDERS.map((p) => ({ ...p, installed: !!getInjectedProvider(p.id) }));
}

const PROVIDER_STORAGE_KEY = "octora.wallet.providerId";

export function SolanaProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => createSolanaClient("devnet"));
  const [wallet, setWallet] = useState<WalletState>({
    address: null,
    connected: false,
    connecting: false,
    providerId: null,
  });
  const [balance, setBalance] = useState<Lamports | null>(null);
  const [providers, setProviders] = useState<WalletProviderInfo[]>(() => detectProviders());

  // Re-detect when the page regains focus — wallet extensions can be installed mid-session.
  useEffect(() => {
    const onFocus = () => setProviders(detectProviders());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const connect = useCallback(async (providerId?: WalletProviderId) => {
    const target =
      providerId ??
      (localStorage.getItem(PROVIDER_STORAGE_KEY) as WalletProviderId | null) ??
      "phantom";

    setWallet((w) => ({ ...w, connecting: true }));
    try {
      const provider = getInjectedProvider(target);
      if (!provider) {
        const info = KNOWN_PROVIDERS.find((p) => p.id === target);
        if (info) window.open(info.installUrl, "_blank", "noopener,noreferrer");
        setWallet((w) => ({ ...w, connecting: false }));
        return;
      }

      const resp = await provider.connect();
      const pubkey = resp.publicKey.toString();

      localStorage.setItem(PROVIDER_STORAGE_KEY, target);
      setWallet({
        address: pubkey as Address,
        connected: true,
        connecting: false,
        providerId: target,
      });
    } catch (err) {
      console.error("Wallet connection failed:", err);
      setWallet({ address: null, connected: false, connecting: false, providerId: null });
    }
  }, []);

  const disconnect = useCallback(() => {
    const id =
      wallet.providerId ??
      (localStorage.getItem(PROVIDER_STORAGE_KEY) as WalletProviderId | null) ??
      "phantom";
    const provider = getInjectedProvider(id);
    provider?.disconnect().catch(() => {});
    localStorage.removeItem(PROVIDER_STORAGE_KEY);
    setWallet({ address: null, connected: false, connecting: false, providerId: null });
    setBalance(null);
  }, [wallet.providerId]);

  const refreshBalance = useCallback(async () => {
    if (!wallet.address) return;
    try {
      const lamports = await getLamportBalance(client.rpc, wallet.address);
      setBalance(lamports);
    } catch {
      // silently fail
    }
  }, [client.rpc, wallet.address]);

  // Auto-refresh every 15s while connected.
  useEffect(() => {
    if (wallet.connected && wallet.address) {
      refreshBalance();
      const interval = setInterval(refreshBalance, 15_000);
      return () => clearInterval(interval);
    }
  }, [wallet.connected, wallet.address, refreshBalance]);

  // Auto-connect to the previously-used provider if it has trusted us.
  useEffect(() => {
    const stored = localStorage.getItem(PROVIDER_STORAGE_KEY) as WalletProviderId | null;
    if (!stored) return;
    const provider = getInjectedProvider(stored);
    if (!provider) return;

    provider
      .connect({ onlyIfTrusted: true })
      .then((resp) => {
        setWallet({
          address: resp.publicKey.toString() as Address,
          connected: true,
          connecting: false,
          providerId: stored,
        });
      })
      .catch(() => {
        // Not previously authorized — ok.
      });
  }, []);

  return (
    <SolanaContext.Provider
      value={{ client, wallet, balance, providers, connect, disconnect, refreshBalance }}
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
