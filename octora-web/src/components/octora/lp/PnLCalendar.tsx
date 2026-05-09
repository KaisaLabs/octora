import { useMemo, useState } from "react";
import { BarChart3, Calendar as CalendarIcon, ChevronLeft, ChevronRight, Clock, LineChart as LineIcon, Share2 } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DailyPnL } from "@/lib/pnl";

interface Props {
  /** Pre-computed daily PnL series in USD. */
  daily: DailyPnL[];
  /** Date considered "now" — drives the today ring and initial month. */
  today: Date;
  /** Defaults to USD; switch when SOL-denominated mode lands. */
  unit?: "USD" | "SOL";
}

type View = "line" | "bar" | "calendar";
type Period = "7D" | "30D" | "90D" | "ALL";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtUsd(n: number, opts: { compact?: boolean } = {}): string {
  const abs = Math.abs(n);
  if (opts.compact) {
    if (abs >= 1000) return `${(n / 1000).toFixed(1)}K`;
    if (abs >= 100) return n.toFixed(0);
    if (abs >= 1) return n.toFixed(2);
    return n.toFixed(2);
  }
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `$${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function signed(n: number, fmt: (x: number) => string): string {
  if (n === 0) return fmt(0);
  return n > 0 ? `+${fmt(n)}` : `−${fmt(Math.abs(n))}`;
}

export function PnLCalendar({ daily, today, unit = "USD" }: Props) {
  const [view, setView] = useState<View>("calendar");
  const [period, setPeriod] = useState<Period>("30D");
  const [cursor, setCursor] = useState<Date>(() => new Date(today.getFullYear(), today.getMonth(), 1));

  const byDate = useMemo(() => {
    const m = new Map<string, DailyPnL>();
    for (const d of daily) m.set(d.date, d);
    return m;
  }, [daily]);

  const monthDays = useMemo(() => buildMonthGrid(cursor), [cursor]);

  const monthlyPnL = useMemo(() => {
    let sum = 0;
    for (const cell of monthDays) {
      if (!cell.inMonth) continue;
      const entry = byDate.get(cell.iso);
      if (entry) sum += entry.pnlUsd;
    }
    return sum;
  }, [monthDays, byDate]);

  const todayIso = isoLocal(today);

  const goPrev = () => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1));
  const goNext = () => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1));
  const goToday = () => setCursor(new Date(today.getFullYear(), today.getMonth(), 1));

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Top bar: view toggle + period + share */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-full border border-border bg-background/40 p-1">
          <ViewIcon active={view === "line"} onClick={() => setView("line")} aria-label="Line chart">
            <LineIcon className="h-4 w-4" />
          </ViewIcon>
          <ViewIcon active={view === "bar"} onClick={() => setView("bar")} aria-label="Bar chart">
            <BarChart3 className="h-4 w-4" />
          </ViewIcon>
          <button
            type="button"
            onClick={() => setView("calendar")}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "calendar"
                ? "bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(160_84%_45%_/_0.4)]"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <CalendarIcon className="h-3.5 w-3.5" />
            Calendar
          </button>
        </div>

        <div className="flex items-center gap-2">
          <PeriodSelect value={period} onChange={setPeriod} />
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <Share2 className="h-3.5 w-3.5" />
            Share
          </button>
        </div>
      </div>

      {/* Month nav */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={goPrev}
            aria-label="Previous month"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background/40 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h3 className="font-display text-base font-semibold tracking-tight text-foreground">
            {MONTH_NAMES[cursor.getMonth()]} {cursor.getFullYear()}
          </h3>
          <button
            type="button"
            onClick={goNext}
            aria-label="Next month"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background/40 text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={goToday}
            className="rounded-md border border-border bg-background/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Today
          </button>
        </div>
        <div className="text-xs text-muted-foreground">
          Monthly PnL:{" "}
          <span className={`ml-1 font-mono tabular-nums ${monthlyPnL >= 0 ? "text-primary" : "text-destructive"}`}>
            {signed(monthlyPnL, (n) => fmtUsd(n))}
          </span>
        </div>
      </div>

      {view === "line" || view === "bar" ? (
        <ChartView view={view} daily={daily} period={period} today={today} />
      ) : view === "calendar" ? (
        <div className="flex-1">
          {/* Weekday header */}
          <div className="grid grid-cols-7 gap-1 border-b border-border/60 pb-2">
            {WEEKDAYS.map((d) => (
              <div key={d} className="text-center text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                {d}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="mt-2 grid grid-cols-7 gap-1">
            {monthDays.map((cell, i) => {
              const entry = byDate.get(cell.iso);
              const isToday = cell.iso === todayIso;
              return (
                <DayCell
                  key={i}
                  day={cell.date.getDate()}
                  inMonth={cell.inMonth}
                  isToday={isToday}
                  pnl={entry?.pnlUsd}
                  positions={entry?.positions}
                  unit={unit}
                />
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ChartView({
  view,
  daily,
  period,
  today,
}: {
  view: "line" | "bar";
  daily: DailyPnL[];
  period: Period;
  today: Date;
}) {
  const data = useMemo(() => {
    const days = period === "7D" ? 7 : period === "30D" ? 30 : period === "90D" ? 90 : 9999;
    const cutoff = new Date(today);
    cutoff.setDate(today.getDate() - (days - 1));
    const cutoffIso = isoLocal(cutoff);
    const sliced = daily.filter((d) => d.date >= cutoffIso).sort((a, b) => a.date.localeCompare(b.date));
    let cum = 0;
    return sliced.map((d) => {
      cum += d.pnlUsd;
      return {
        date: d.date,
        label: shortDateLabel(d.date),
        pnl: d.pnlUsd,
        cumulative: cum,
      };
    });
  }, [daily, period, today]);

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        {view === "line" ? (
          <AreaChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: -16 }}>
            <defs>
              <linearGradient id="cum-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(160 84% 55%)" stopOpacity={0.45} />
                <stop offset="100%" stopColor="hsl(160 84% 55%)" stopOpacity={0.02} />
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
            <ReferenceLine y={0} stroke="hsl(155 20% 22%)" strokeDasharray="2 3" />
            <Tooltip
              cursor={{ stroke: "hsl(160 84% 39% / 0.35)", strokeWidth: 1 }}
              contentStyle={tooltipStyle}
              formatter={(v: number) => [signed(v, (n) => fmtUsd(n)), "Cumulative"]}
            />
            <Area
              type="monotone"
              dataKey="cumulative"
              stroke="hsl(160 84% 55%)"
              strokeWidth={1.75}
              fill="url(#cum-grad)"
            />
          </AreaChart>
        ) : (
          <BarChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: -16 }}>
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
            <ReferenceLine y={0} stroke="hsl(155 20% 22%)" strokeDasharray="2 3" />
            <Tooltip
              cursor={{ fill: "hsl(160 84% 39% / 0.06)" }}
              contentStyle={tooltipStyle}
              formatter={(v: number) => [signed(v, (n) => fmtUsd(n)), "Daily"]}
            />
            <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.pnl >= 0 ? "hsl(160 84% 50%)" : "hsl(0 72% 51%)"} />
              ))}
            </Bar>
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

const tooltipStyle: React.CSSProperties = {
  background: "hsl(155 30% 6%)",
  border: "1px solid hsl(155 20% 16%)",
  borderRadius: 10,
  fontSize: 12,
  fontFamily: "Geist Mono, ui-monospace, monospace",
};

function compactUsd(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function shortDateLabel(iso: string): string {
  // iso = YYYY-MM-DD
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}

interface MonthCell {
  date: Date;
  inMonth: boolean;
  iso: string;
}

function buildMonthGrid(cursor: Date): MonthCell[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const startWeekday = first.getDay(); // 0 = Sunday
  const start = new Date(first);
  start.setDate(first.getDate() - startWeekday);

  const cells: MonthCell[] = [];
  // Render up to 6 weeks; trim trailing empty rows.
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push({ date: d, inMonth: d.getMonth() === cursor.getMonth(), iso: isoLocal(d) });
  }

  // Trim trailing weeks that are all out-of-month.
  while (cells.length > 28) {
    const lastWeek = cells.slice(-7);
    if (lastWeek.every((c) => !c.inMonth)) cells.splice(-7);
    else break;
  }
  return cells;
}

function DayCell({
  day,
  inMonth,
  isToday,
  pnl,
  positions,
  unit,
}: {
  day: number;
  inMonth: boolean;
  isToday: boolean;
  pnl?: number;
  positions?: number;
  unit: "USD" | "SOL";
}) {
  const hasPnl = typeof pnl === "number";
  const positive = (pnl ?? 0) > 0;
  const negative = (pnl ?? 0) < 0;
  const flat = hasPnl && pnl === 0;

  let toneClass = "border-border/60 bg-background/40 text-muted-foreground";
  if (inMonth && hasPnl) {
    if (positive) toneClass = "border-primary/40 bg-primary/10 text-primary";
    else if (negative) toneClass = "border-destructive/40 bg-destructive/10 text-destructive";
    else toneClass = "border-border/70 bg-background/40 text-muted-foreground";
  } else if (!inMonth) {
    toneClass = "border-transparent bg-transparent text-muted-foreground/30";
  }

  return (
    <div
      className={`relative flex aspect-[1.45/1] flex-col justify-between rounded-md border px-2 py-1.5 text-left transition-colors ${toneClass} ${
        isToday ? "ring-1 ring-amber-400/70" : ""
      }`}
    >
      <span
        className={`text-[10px] font-medium tabular-nums ${
          inMonth ? (isToday ? "text-amber-300" : "text-foreground/70") : "text-muted-foreground/40"
        }`}
      >
        {day}
      </span>

      {inMonth && hasPnl && (
        <div className="flex flex-col">
          <span
            className={`font-mono text-[11px] font-semibold tabular-nums leading-tight ${
              positive ? "text-primary" : negative ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            {flat
              ? unit === "SOL"
                ? "0 SOL"
                : "$0"
              : signed(pnl, (n) => fmtUsd(n, { compact: true }))}
          </span>
          {positions ? (
            <span className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/70">
              {positions} pos
            </span>
          ) : null}
        </div>
      )}

      {isToday && (
        <span
          aria-hidden
          className="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_hsl(48_96%_60%)]"
        />
      )}
    </div>
  );
}

function ViewIcon({
  active,
  onClick,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
        active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
      }`}
      {...rest}
    >
      {children}
    </button>
  );
}

function PeriodSelect({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 100)}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Clock className="h-3.5 w-3.5" />
        {value}
        <span className="text-foreground/60">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 overflow-hidden rounded-lg border border-border bg-popover shadow-soft">
          {(["7D", "30D", "90D", "ALL"] as Period[]).map((p) => (
            <button
              key={p}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(p);
                setOpen(false);
              }}
              className={`block w-full px-3 py-1.5 text-left text-xs transition-colors ${
                p === value ? "bg-surface-elevated text-foreground" : "text-muted-foreground hover:bg-surface-elevated/60 hover:text-foreground"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

