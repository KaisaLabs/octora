import { Shield, ShieldAlert, ShieldOff } from "lucide-react";

/**
 * Visual indicator of how big a mixer pool's current anonymity set is.
 *
 * The server returns the `anonymitySet` value as `nextLeafIndex -
 * withdrawalCount` — i.e. the count of unspent deposits in the pool.
 * That number is the upper bound on how many leaves an observer could
 * plausibly link to any given withdrawal, so it's a direct proxy for
 * how much privacy a withdrawal from this pool actually buys.
 *
 * Thresholds match the API gate (MIN_ANONYMITY_SET = 20):
 *   - green  ≥ 20: above the API floor; withdrawals will be accepted
 *   - amber  5–19: workable for testing, but server will refuse withdraw
 *   - coral  < 5:  effectively no privacy; do not deposit
 */
export type AnonymityTier = "strong" | "weak" | "thin";

export function tierForAnonymity(set: number): AnonymityTier {
  if (set >= 20) return "strong";
  if (set >= 5) return "weak";
  return "thin";
}

interface Props {
  anonymitySet: number;
  /** When true, renders the smaller pill variant (denomination pills). */
  compact?: boolean;
}

const COPY: Record<AnonymityTier, { label: string; hint: string }> = {
  strong: {
    label: "Strong privacy",
    hint: "Withdrawal allowed. Pool has enough unspent deposits to mask yours.",
  },
  weak: {
    label: "Thin set",
    hint: "Too few unspent deposits to meet the 20-deposit floor — server will reject withdrawals from this pool until more deposits land.",
  },
  thin: {
    label: "No privacy yet",
    hint: "Pool is essentially empty. A withdrawal here would be trivially linkable to your deposit.",
  },
};

export function AnonymityBadge({ anonymitySet, compact = false }: Props) {
  const tier = tierForAnonymity(anonymitySet);
  const copy = COPY[tier];
  const Icon = tier === "strong" ? Shield : tier === "weak" ? ShieldAlert : ShieldOff;

  const colorClass =
    tier === "strong"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : tier === "weak"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
      : "border-rose-500/40 bg-rose-500/10 text-rose-300";

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${colorClass}`}
        title={copy.hint}
      >
        <Icon className="h-3 w-3" />
        {anonymitySet} unspent
      </span>
    );
  }

  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${colorClass}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-0.5">
        <div className="font-medium">
          {copy.label} — {anonymitySet} unspent deposit{anonymitySet === 1 ? "" : "s"}
        </div>
        <div className="text-[11px] opacity-80">{copy.hint}</div>
      </div>
    </div>
  );
}
