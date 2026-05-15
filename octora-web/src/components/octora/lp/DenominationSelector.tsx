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

interface PoolViewEntry extends MixerPoolEntry {
  /** True when the pool meets MIN_ANONYMITY_SET — i.e. server will accept a withdraw build. */
  usable: boolean;
  /** Human-readable explanation for why the pool is disabled, when `usable === false`. */
  disabledReason: string | null;
}

// Denominations the backend exposes but the deposit path can't honour yet.
// Render disabled-with-explanation rather than hiding so the ladder shape
// ({0.1, 1, 5, 10} SOL) stays legible (per feedback_truthful_ui.md).
const UNSUPPORTED_DENOM_LAMPORTS = new Set<string>(["5000000000"]);
const UNSUPPORTED_DENOM_REASON = "5 SOL deposits aren't supported yet — coming soon.";

export function DenominationSelector({ value, onChange, enabled = true }: Props) {
  const [pools, setPools] = useState<PoolViewEntry[] | null>(null);
  const [anonymitySetMin, setAnonymitySetMin] = useState(20);
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
        const min = data.anonymitySetMin ?? 20;
        setAnonymitySetMin(min);
        // Render every configured denomination in the Denomination ladder so
        // operators / users can see the full {0.1, 1, 5, 10} SOL shape at a
        // glance — but disable buckets the backend will refuse (per memory
        // `feedback_truthful_ui.md`: disabled-with-explanation beats hiding,
        // because a missing bucket is indistinguishable from a broken
        // config). Pools that aren't initialized on-chain at all stay hidden
        // — there's no useful action a user can take on those.
        const viewPools: PoolViewEntry[] = (data.pools ?? [])
          .filter((p) => p.initialized !== false)
          .map((p) => {
            if (UNSUPPORTED_DENOM_LAMPORTS.has(p.denomination)) {
              return { ...p, usable: false, disabledReason: UNSUPPORTED_DENOM_REASON };
            }
            const anonymitySet = p.anonymitySet ?? 0;
            if (p.isPaused) {
              return {
                ...p,
                usable: false,
                disabledReason: "Pool is paused by admin — deposits and withdrawals are disabled.",
              };
            }
            if (anonymitySet < min) {
              const need = Math.max(0, min - anonymitySet);
              return {
                ...p,
                usable: false,
                disabledReason: `Needs ${need} more deposit${need === 1 ? "" : "s"} before it's privacy-safe (current Anonymity Set: ${anonymitySet}, required: ${min}).`,
              };
            }
            return { ...p, usable: true, disabledReason: null };
          });
        setPools(viewPools);
        setError(null);
        // Auto-select the largest *usable* pool if none chosen yet — the user
        // can override, but the default should favour the highest-privacy
        // bucket the server will actually accept.
        if (!value) {
          const usable = viewPools.filter((p) => p.usable);
          if (usable.length > 0) {
            const chosen = [...usable].sort((a, b) => Number(b.denomination) - Number(a.denomination))[0]!;
            onChange(chosen.denomination, chosen.anonymitySet ?? 0);
          }
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
        No mixer pool has been initialized on-chain yet.
      </div>
    );
  }

  const anyUsable = pools.some((p) => p.usable);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        {pools.map((pool) => {
          const selected = pool.denomination === value;
          const sol = formatSol(pool.denomination);
          const disabled = !pool.usable;
          return (
            <button
              key={pool.denomination}
              type="button"
              disabled={disabled}
              aria-disabled={disabled}
              title={pool.disabledReason ?? undefined}
              onClick={() => {
                if (disabled) return;
                onChange(pool.denomination, pool.anonymitySet ?? 0);
              }}
              data-testid={`denom-${pool.denomination}`}
              data-usable={pool.usable ? "true" : "false"}
              className={[
                "flex flex-col items-stretch gap-1.5 rounded-md border px-3 py-2.5 text-left transition-colors",
                disabled
                  ? "cursor-not-allowed border-border/40 bg-card/20 text-muted-foreground opacity-60"
                  : selected
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

      {!anyUsable && (
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 text-xs text-muted-foreground">
          No mixer pool has reached the {anonymitySetMin}-deposit privacy threshold yet.
          Hover a bucket above to see how many more deposits it needs.
        </div>
      )}

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
