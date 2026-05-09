/**
 * Solana cluster configuration (P1-34).
 *
 * Cluster is driven by `VITE_NETWORK`, the same env var the API client
 * reads in `lib/api.ts`. Production builds (`import.meta.env.PROD`)
 * throw at module-load when the variable is unset — silently shipping a
 * mainnet bundle that points at devnet is exactly the misconfiguration
 * the audit (P1-34) calls out, so we fail fast.
 *
 * Localnet is supported for `pnpm dev` against a surfpool / surfnet
 * fork; localnet builds skip the genesis-hash mismatch check.
 */
export type Cluster = "mainnet" | "devnet" | "localnet";

export const SOLANA_CONFIG = {
  devnet: {
    rpc: import.meta.env.VITE_SOLANA_RPC_URL_DEVNET || "https://api.devnet.solana.com",
    ws: import.meta.env.VITE_SOLANA_WS_URL_DEVNET || "wss://api.devnet.solana.com",
  },
  mainnet: {
    rpc: import.meta.env.VITE_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    ws: import.meta.env.VITE_SOLANA_WS_URL || "wss://api.mainnet-beta.solana.com",
  },
  localnet: {
    rpc: import.meta.env.VITE_SOLANA_RPC_URL_LOCALNET || "http://127.0.0.1:8899",
    ws: import.meta.env.VITE_SOLANA_WS_URL_LOCALNET || "ws://127.0.0.1:8900",
  },
} as const;

/**
 * Known genesis hashes used by `useNetworkStatus` to verify the configured
 * RPC actually serves the cluster the build claims. A mismatch here means
 * either the RPC URL is wrong or someone shipped a devnet bundle to a
 * mainnet domain — both should block mutating actions, see P1-35.
 */
export const KNOWN_GENESIS_HASHES: Record<Cluster, string | null> = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  // Localnet/surfnet genesis is non-deterministic; mismatch checks skip it.
  localnet: null,
};

function loadCluster(): Cluster {
  const raw = (import.meta.env.VITE_NETWORK as string | undefined)?.trim();

  if (raw === "mainnet" || raw === "devnet" || raw === "localnet") {
    return raw;
  }

  // PROD with no value (or a typo) → throw at module load. Vite chunks
  // every page through this file, so a missing var fails the bundle
  // before the first user sees a blank screen pointed at devnet.
  if (import.meta.env.PROD) {
    throw new Error(
      `VITE_NETWORK is required in production builds (got: ${JSON.stringify(raw)}). ` +
        `Set it to "mainnet", "devnet", or "localnet" before building.`,
    );
  }

  return "devnet";
}

/**
 * The active cluster for this build, resolved from `VITE_NETWORK` at
 * module load. Re-exported by the rest of the frontend so a single
 * source of truth controls every RPC URL, banner, and label.
 */
export const ACTIVE_CLUSTER: Cluster = loadCluster();

/**
 * @deprecated Use `ACTIVE_CLUSTER` directly. Kept to avoid breaking the
 * (small) number of call sites that read this constant.
 */
export const DEFAULT_CLUSTER: Cluster = ACTIVE_CLUSTER;

export function getClusterConfig(cluster?: Cluster) {
  return SOLANA_CONFIG[cluster ?? ACTIVE_CLUSTER];
}
