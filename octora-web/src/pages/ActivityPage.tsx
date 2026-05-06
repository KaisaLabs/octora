import { useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Coins,
  Copy,
  Download,
  ExternalLink,
  Repeat,
  Shield,
} from "lucide-react";
import type { ActivityKind, PortfolioActivity } from "@/components/octora/types";

interface ActivityPageProps {
  activity: PortfolioActivity[];
}

type Filter = "all" | ActivityKind;

const KIND_META: Record<
  ActivityKind,
  { label: string; icon: React.ComponentType<{ className?: string }>; tone: string; ring: string }
> = {
  deposit: {
    label: "Deposit",
    icon: ArrowDownToLine,
    tone: "text-primary",
    ring: "border-primary/30 bg-primary/10",
  },
  withdraw: {
    label: "Withdraw",
    icon: ArrowUpFromLine,
    tone: "text-amber-400",
    ring: "border-amber-500/30 bg-amber-500/10",
  },
  claim: {
    label: "Claim",
    icon: Coins,
    tone: "text-primary",
    ring: "border-primary/30 bg-primary/10",
  },
  rebalance: {
    label: "Rebalance",
    icon: Repeat,
    tone: "text-foreground",
    ring: "border-border bg-secondary/60",
  },
};

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "deposit", label: "Deposits" },
  { value: "withdraw", label: "Withdraws" },
  { value: "claim", label: "Claims" },
  { value: "rebalance", label: "Rebalances" },
];

export function ActivityPage({ activity }: ActivityPageProps) {
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = useMemo(
    () => activity.filter((a) => filter === "all" || a.kind === filter),
    [activity, filter],
  );

  const groups = useMemo(() => groupByDay(filtered), [filtered]);
  const counts = useMemo(() => {
    const map = new Map<Filter, number>();
    map.set("all", activity.length);
    for (const a of activity) map.set(a.kind, (map.get(a.kind) ?? 0) + 1);
    return map;
  }, [activity]);

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Activity</p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Private settlement log
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {activity.length} event{activity.length === 1 ? "" : "s"} routed through the private path.
          </p>
        </div>
        <button
          type="button"
          onClick={() => exportCsv(activity)}
          disabled={activity.length === 0}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </button>
      </section>

      <section className="panel-shell rounded-2xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Filter</span>
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                filter === f.value
                  ? "border-primary/40 bg-surface-elevated text-foreground"
                  : "border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.label}
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground/80">
                {counts.get(f.value) ?? 0}
              </span>
            </button>
          ))}
        </div>

        {groups.length === 0 ? (
          <div className="mt-6 rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
            No activity matches this filter.
          </div>
        ) : (
          <div className="relative mt-6">
            {/* Timeline rail */}
            <span aria-hidden className="absolute left-[19px] top-1 h-full w-px bg-border/60" />

            <div className="space-y-6">
              {groups.map((g) => (
                <DayGroup key={g.label} label={g.label} items={g.items} />
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

interface Group {
  label: string;
  items: PortfolioActivity[];
}

function groupByDay(items: PortfolioActivity[]): Group[] {
  const buckets = new Map<string, PortfolioActivity[]>();
  for (const it of items) {
    const ts = it.timestamp ? new Date(it.timestamp) : null;
    const key = ts ? labelForDay(ts) : "Earlier";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(it);
  }
  return Array.from(buckets.entries()).map(([label, items]) => ({ label, items }));
}

function labelForDay(d: Date): string {
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startToday - startThat) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function DayGroup({ label, items }: Group) {
  return (
    <div>
      <p className="ml-12 text-[11px] uppercase tracking-[0.22em] text-muted-foreground">{label}</p>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <ActivityRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

function ActivityRow({ item }: { item: PortfolioActivity }) {
  const meta = KIND_META[item.kind];
  const Icon = meta.icon;

  return (
    <li className="relative flex items-start gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/20">
      {/* Icon dot on the rail */}
      <div
        className={`relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border ${meta.ring}`}
      >
        <Icon className={`h-4 w-4 ${meta.tone}`} />
      </div>

      <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-medium text-foreground">
            {item.action} <span className="text-muted-foreground">·</span>{" "}
            <span className="text-muted-foreground">{item.poolName}</span>
          </p>
          <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <Shield className="h-3 w-3" />
            {item.privacy}
            {item.txSignature && (
              <>
                <span className="text-muted-foreground/50">·</span>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(item.txSignature ?? "")}
                  className="inline-flex items-center gap-1 font-mono text-foreground/80 transition-colors hover:text-foreground"
                  title="Copy signature"
                >
                  {shorten(item.txSignature)}
                  <Copy className="h-3 w-3" />
                </button>
                <a
                  href={`https://solscan.io/tx/${item.txSignature}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center text-foreground/80 transition-colors hover:text-primary"
                  title="View on Solscan"
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
          </p>
        </div>

        <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-0.5">
          <span className={`font-mono text-base font-semibold tabular-nums ${meta.tone}`}>
            {item.value}
          </span>
          <span className="text-[11px] text-muted-foreground">{item.time}</span>
        </div>
      </div>
    </li>
  );
}

function shorten(sig: string): string {
  if (sig.length <= 12) return sig;
  return `${sig.slice(0, 6)}…${sig.slice(-4)}`;
}

function exportCsv(items: PortfolioActivity[]) {
  if (items.length === 0) return;
  const header = ["timestamp", "kind", "action", "pool", "value", "privacy", "tx_signature"];
  const rows = items.map((i) => [
    i.timestamp ?? "",
    i.kind,
    i.action,
    i.poolName,
    i.value,
    i.privacy,
    i.txSignature ?? "",
  ]);
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `octora-activity-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvCell(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
