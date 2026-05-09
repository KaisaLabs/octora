import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Window = "24H" | "7D" | "30D";

export interface PnLPoint {
  /** Hours since position open. */
  t: number;
  /** Cumulative fees earned (USD). */
  fees: number;
  /** Cumulative IL impact (USD, typically <= 0). */
  il: number;
  /** Cumulative price-driven contribution (USD, signed). */
  price: number;
}

interface Props {
  /** Full series. The chart subsamples by window. */
  series: PnLPoint[];
  /** Hours represented by the full series (used to label axis). */
  totalHours: number;
}

const WINDOWS: { label: Window; hours: number }[] = [
  { label: "24H", hours: 24 },
  { label: "7D", hours: 24 * 7 },
  { label: "30D", hours: 24 * 30 },
];

export function PnLBreakdownChart({ series, totalHours }: Props) {
  const [window, setWindow] = useState<Window>("7D");

  const data = useMemo(() => {
    const w = WINDOWS.find((x) => x.label === window)!;
    const cutoff = Math.max(0, totalHours - w.hours);
    const sliced = series.filter((p) => p.t >= cutoff);
    return sliced.map((p) => ({
      ...p,
      total: p.fees + p.il + p.price,
      label: formatHourLabel(p.t, totalHours, w.hours),
    }));
  }, [series, totalHours, window]);

  const lastFee = data.at(-1)?.fees ?? 0;
  const lastIl = data.at(-1)?.il ?? 0;
  const lastPrice = data.at(-1)?.price ?? 0;
  const total = lastFee + lastIl + lastPrice;

  return (
    <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">P&L breakdown</p>
          <p className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            <span className={total >= 0 ? "text-primary" : "text-destructive"}>
              {signedUsd(total)}
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Net of fees, IL, and price drift over {window.toLowerCase()}.</p>
        </div>

        <div className="flex items-center gap-1 rounded-full border border-border bg-background/40 p-1">
          {WINDOWS.map(({ label }) => (
            <button
              key={label}
              type="button"
              onClick={() => setWindow(label)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                window === label
                  ? "bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(160_84%_45%_/_0.4)]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <Legend label="Fees" value={lastFee} tone="up" />
        <Legend label="IL" value={lastIl} tone={lastIl < 0 ? "down" : "neutral"} />
        <Legend label="Price drift" value={lastPrice} tone={lastPrice >= 0 ? "up" : "down"} />
      </div>

      <div className="mt-4 h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: -16 }}>
            <defs>
              <linearGradient id="grad-fees" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(160 84% 55%)" stopOpacity={0.55} />
                <stop offset="100%" stopColor="hsl(160 84% 55%)" stopOpacity={0.04} />
              </linearGradient>
              <linearGradient id="grad-price" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(38 92% 56%)" stopOpacity={0.45} />
                <stop offset="100%" stopColor="hsl(38 92% 56%)" stopOpacity={0.03} />
              </linearGradient>
              <linearGradient id="grad-il" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(0 72% 51%)" stopOpacity={0.45} />
                <stop offset="100%" stopColor="hsl(0 72% 51%)" stopOpacity={0.03} />
              </linearGradient>
            </defs>

            <CartesianGrid stroke="hsl(155 20% 14%)" strokeDasharray="3 4" vertical={false} />
            <XAxis
              dataKey="label"
              stroke="hsl(152 20% 55%)"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              minTickGap={32}
            />
            <YAxis
              stroke="hsl(152 20% 55%)"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => compactUsd(v)}
              width={48}
            />
            <Tooltip
              cursor={{ stroke: "hsl(160 84% 39% / 0.4)", strokeWidth: 1 }}
              contentStyle={{
                background: "hsl(155 30% 6%)",
                border: "1px solid hsl(155 20% 16%)",
                borderRadius: 10,
                fontSize: 12,
                fontFamily: "Geist Mono, ui-monospace, monospace",
              }}
              formatter={(v: number, name: string) => [signedUsd(v), labelFor(name)]}
              labelFormatter={(l: string) => l}
            />
            <Area type="monotone" dataKey="fees" stroke="hsl(160 84% 55%)" fill="url(#grad-fees)" strokeWidth={1.5} />
            <Area type="monotone" dataKey="price" stroke="hsl(38 92% 56%)" fill="url(#grad-price)" strokeWidth={1.5} />
            <Area type="monotone" dataKey="il" stroke="hsl(0 72% 51%)" fill="url(#grad-il)" strokeWidth={1.5} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function labelFor(key: string): string {
  if (key === "fees") return "Fees";
  if (key === "il") return "IL";
  if (key === "price") return "Price drift";
  return key;
}

function Legend({ label, value, tone }: { label: string; value: number; tone: "up" | "down" | "neutral" }) {
  const dot =
    tone === "up"
      ? "bg-primary shadow-[0_0_6px_hsl(160_84%_55%)]"
      : tone === "down"
      ? "bg-destructive"
      : "bg-amber-400";
  const color = tone === "up" ? "text-primary" : tone === "down" ? "text-destructive" : "text-amber-400";
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {label}
      </div>
      <p className={`font-mono text-sm font-medium tabular-nums ${color}`}>{signedUsd(value)}</p>
    </div>
  );
}

function signedUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0.00";
  const abs = Math.abs(n);
  const txt =
    abs >= 1_000_000
      ? `$${(abs / 1_000_000).toFixed(2)}M`
      : abs >= 10_000
      ? `$${(abs / 1000).toFixed(1)}K`
      : `$${abs.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return n > 0 ? `+${txt}` : `−${txt}`;
}

function compactUsd(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function formatHourLabel(t: number, totalHours: number, windowHours: number): string {
  const hoursAgo = Math.max(0, totalHours - t);
  if (windowHours <= 24) return `-${hoursAgo}h`;
  const days = Math.round(hoursAgo / 24);
  return days === 0 ? "now" : `-${days}d`;
}
