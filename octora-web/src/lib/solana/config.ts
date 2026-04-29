/** Solana RPC configuration */
export const SOLANA_CONFIG = {
  devnet: {
    rpc: "https://api.devnet.solana.com",
    ws: "wss://api.devnet.solana.com",
  },
  mainnet: {
    rpc: import.meta.env.VITE_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    ws: import.meta.env.VITE_SOLANA_WS_URL || "wss://api.mainnet-beta.solana.com",
  },
} as const;

export const DEFAULT_CLUSTER: "devnet" | "mainnet" = "devnet";

export function getClusterConfig(cluster?: "devnet" | "mainnet") {
  return SOLANA_CONFIG[cluster ?? DEFAULT_CLUSTER];
}
