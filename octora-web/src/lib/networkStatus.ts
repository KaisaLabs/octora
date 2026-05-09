import { useEffect, useState } from "react";
import { ACTIVE_CLUSTER, KNOWN_GENESIS_HASHES, type Cluster } from "@/lib/solana/config";
import { useSolana } from "@/providers/SolanaProvider";

/**
 * Network mismatch detection (P1-35).
 *
 * Calls `getGenesisHash` against the app's RPC and compares it to the
 * canonical hash for the build's `ACTIVE_CLUSTER`. A mismatch here means
 * either:
 *   - The RPC URL is misconfigured (e.g. mainnet bundle pointed at devnet).
 *   - Someone shipped a stale build to the wrong domain.
 *
 * Both cases must block mutating actions and show a banner explaining
 * what the user is actually connected to. Localnet is exempt because
 * surfpool / surfnet genesis hashes are non-deterministic.
 *
 * The wallet itself isn't queried — Solana wallet extensions don't
 * surface a stable "current cluster" attribute, and they sign whatever
 * blockhash the dApp passes anyway. The dApp-side genesis check catches
 * the misconfigurations the audit cares about; we surface a separate
 * advisory in the banner so the user knows to double-check their wallet
 * if the app is on devnet/localnet.
 */
export type NetworkStatus =
  | { state: "checking" }
  | { state: "ok"; cluster: Cluster; genesisHash: string }
  | {
      state: "mismatch";
      cluster: Cluster;
      expectedHash: string;
      observedHash: string;
    }
  | { state: "rpc-error"; cluster: Cluster; message: string };

const REFRESH_INTERVAL_MS = 60_000;

export function useNetworkStatus(): NetworkStatus {
  const { client } = useSolana();
  const [status, setStatus] = useState<NetworkStatus>({ state: "checking" });

  useEffect(() => {
    let cancelled = false;

    async function check() {
      // Skip the genesis-hash check on localnet — surfpool fixtures use
      // a fresh chain on every spin-up so any hash is "right".
      if (ACTIVE_CLUSTER === "localnet") {
        if (!cancelled) setStatus({ state: "ok", cluster: "localnet", genesisHash: "(localnet)" });
        return;
      }

      const expected = KNOWN_GENESIS_HASHES[ACTIVE_CLUSTER];
      if (!expected) {
        if (!cancelled) setStatus({ state: "ok", cluster: ACTIVE_CLUSTER, genesisHash: "(unknown)" });
        return;
      }

      try {
        // `@solana/kit`'s rpc client returns the hash directly as a string.
        const hash = await client.rpc.getGenesisHash().send();
        const observed = String(hash);
        if (cancelled) return;
        if (observed === expected) {
          setStatus({ state: "ok", cluster: ACTIVE_CLUSTER, genesisHash: observed });
        } else {
          setStatus({
            state: "mismatch",
            cluster: ACTIVE_CLUSTER,
            expectedHash: expected,
            observedHash: observed,
          });
        }
      } catch (err) {
        if (cancelled) return;
        setStatus({
          state: "rpc-error",
          cluster: ACTIVE_CLUSTER,
          message: err instanceof Error ? err.message : "RPC unreachable",
        });
      }
    }

    void check();
    const id = setInterval(() => void check(), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [client]);

  return status;
}

/**
 * `true` when the network state is unsafe to sign mutating txs against.
 * UI components should disable submit buttons + render a banner when this
 * flips on, and re-enable when it goes back to `false`.
 */
export function isNetworkUnsafe(status: NetworkStatus): boolean {
  return status.state === "mismatch" || status.state === "rpc-error";
}
