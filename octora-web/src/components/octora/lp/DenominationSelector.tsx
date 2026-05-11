import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { AnonymityBadge } from "./AnonymityBadge";

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";

/**
 * Single entry returned by `GET /mixer/pools`. Field names mirror the API
 * response so we can pass the raw payload straight into the picker without a
 * mapping layer.
 */
export interface MixerPoolEntry {
  denomination: string;
  initialized?: boolean;
  poolAddress?: string;
  anonymitySet?: number;
  anonymitySetMin?: number;
  depositCount?: number;
  withdrawalCount?: number;
  isPaused?: boolean;
  balanceLamports?: string;
  nextLeafIndex?: number;
}

interface PoolsResponse {
  pools: MixerPoolEntry[];
  anonymitySetMin?: number;
}

interface Props {
  /** Selected denomination in lamports (base-10 string). */
  value: string | null;
  /**
   * Fires when the user picks a pool. `anonymitySet` is the current count of
   * unspent deposits in that pool, used by callers to decide whether to gate
   * the next step on an "I understand the pool is thin" ack.
   */
  onChange: (denominationLamports: string, anonymitySet: number) => void;
  /** When true, the component fetches on mount; otherwise it stays idle. */
  enabled?: boolean;
}

export function DenominationSelector({ value, onChange, enabled = true }: Props) {
  const [pools, setPools] = useState<MixerPoolEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    fetch(`${API_BASE}/mixer/pools`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        return res.json() as Promise<PoolsResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setPools(data.pools ?? []);
        setError(null);
        // Auto-select the largest strong pool if none chosen yet — the user
        // can override, but the default should favour the highest-privacy
        // option that's actually usable.
        if (!value && data.pools && data.pools.length > 0) {
          const strong = data.pools
            .filter((p) => (p.anonymitySet ?? 0) >= (data.anonymitySetMin ?? 20))
            .sort((a, b) => Number(b.denomination) - Number(a.denomination))[0];
          const fallback = data.pools[0]!;
          const chosen = strong ?? fallback;
          onChange(chosen.denomination, chosen.anonymitySet ?? 0);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // We want this effect to fire once per `enabled` flip; including `value`
    // and `onChange` would re-fetch on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border/60 bg-card/40 px-3 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading available pools…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
        Couldn't load mixer pools: {error}
      </div>
    );
  }

  if (!pools || pools.length === 0) {
    return (
      <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 text-xs text-muted-foreground">
        No mixer pools configured on this network.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        {pools.map((pool) => {
          const selected = pool.denomination === value;
          const sol = formatSol(pool.denomination);
          const usable = pool.initialized !== false && pool.isPaused !== true;
          return (
            <button
              key={pool.denomination}
              type="button"
              disabled={!usable}
              onClick={() => onChange(pool.denomination, pool.anonymitySet ?? 0)}
              className={[
                "flex flex-col items-stretch gap-1.5 rounded-md border px-3 py-2.5 text-left transition-colors",
                "disabled:cursor-not-allowed disabled:opacity-50",
                selected
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border/60 bg-card/40 text-muted-foreground hover:border-border hover:text-foreground",
              ].join(" ")}
            >
              <span className="text-sm font-semibold tabular-nums">{sol}</span>
              {pool.anonymitySet !== undefined ? (
                <AnonymityBadge anonymitySet={pool.anonymitySet} compact />
              ) : (
                <span className="text-[10px] uppercase tracking-wide opacity-70">
                  Not initialized
                </span>
              )}
            </button>
          );
        })}
      </div>

      {value !== null &&
        (() => {
          const selected = pools.find((p) => p.denomination === value);
          if (!selected || selected.anonymitySet === undefined) return null;
          return <AnonymityBadge anonymitySet={selected.anonymitySet} />;
        })()}
    </div>
  );
}

function formatSol(lamportsStr: string): string {
  try {
    const lamports = BigInt(lamportsStr);
    const whole = lamports / 1_000_000_000n;
    const frac = lamports % 1_000_000_000n;
    if (frac === 0n) return `${whole} SOL`;
    const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
    return `${whole}.${fracStr} SOL`;
  } catch {
    return `${lamportsStr} lamports`;
  }
}
