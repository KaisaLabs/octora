import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  type Lamports,
  type Address,
} from "@solana/kit";
import { getClusterConfig } from "./config";

/* ─────────────────────────────────────────────────────────
 * Solana client — browser-safe @solana/kit wrapper
 *
 * Provides RPC, subscriptions, and helpers.
 * All functions are browser-compatible.
 * ───────────────────────────────────────────────────────── */

/** Infer the RPC type from createSolanaRpc */
export type Rpc = ReturnType<typeof createSolanaRpc>;

/** Infer the RPC subscriptions type */
export type RpcSubscriptions = ReturnType<typeof createSolanaRpcSubscriptions>;

export async function getLamportBalance(rpc: Rpc, address: Address): Promise<Lamports> {
  const { value } = await rpc.getBalance(address).send();
  return value;
}

export async function getLatestBlockhash(rpc: Rpc) {
  const { value } = await rpc.getLatestBlockhash().send();
  return value;
}

export function createSolanaClient(cluster?: "devnet" | "mainnet") {
  const { rpc: rpcUrl, ws: wsUrl } = getClusterConfig(cluster);

  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);

  return {
    rpc,
    rpcSubscriptions,
    cluster: cluster ?? ("devnet" as const),
  };
}

export type SolanaClient = ReturnType<typeof createSolanaClient>;
