import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

import {
  listLocalPositions,
  POSITIONS_CHANGED_EVENT,
  type StoredPosition,
} from "@/lib/localPositions";

/**
 * Activity calendar for the portfolio Overview tab.
 *
 * Each cell aggregates the real lifecycle events from `localPositions` —
 * deposit days (green) and close days (amber). No synthetic per-day P&L:
 * the underlying browser index only knows deposit timestamps + close
 * timestamps + deposit-time USD, so anything else would be invented.
 *
 * The monthly footer counts events for the visible month so the user can
 * see "this month: 2 deposits · 1 close" at a glance.
 */

interface Props {
  walletAddress: string | null | undefined;
  /** Date considered "now" — drives the today ring and initial month. */
  today: Date;
}

interface DayEvents {
  deposits: number;
  closes: number;
  /** Sum of depositedUsd across the day's deposit events. We have this
   *  because StoredPosition captures the deposit-time USD at deposit time. */
  depositedUsd: number;
}

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

function fmtUsdCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  if (abs >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

export function ActivityCalendar({ walletAddress, today }: Props) {
  // Re-read on same-tab mutations (custom event) + cross-tab (storage event).
  // Same subscription pattern as usePortfolioPositions and RecentActivityPanel.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(POSITIONS_CHANGED_EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(POSITIONS_CHANGED_EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);

  const stored = useMemo(
    () => listLocalPositions(walletAddress),
    [walletAddress, version],
  );

  const [cursor, setCursor] = useState<Date>(
    () => new Date(today.getFullYear(), today.getMonth(), 1),
  );

  const eventsByDate = useMemo(() => {
    const map = new Map<string, DayEvents>();
    const bump = (iso: string, patch: Partial<DayEvents>) => {
      const cur = map.get(iso) ?? { deposits: 0, closes: 0, depositedUsd: 0 };
      map.set(iso, {
        deposits: cur.deposits + (patch.deposits ?? 0),
        closes: cur.closes + (patch.closes ?? 0),
        depositedUsd: cur.depositedUsd + (patch.depositedUsd ?? 0),
      });
    };
    for (const s of stored) {
      bump(isoLocal(new Date(s.ts)), { deposits: 1, depositedUsd: s.depositedUsd ?? 0 });
      if (s.closed && s.closedAt) {
        bump(isoLocal(new Date(s.closedAt)), { closes: 1 });
      }
    }
    return map;
  }, [stored]);

  const monthDays = useMemo(() => buildMonthGrid(cursor), [cursor]);

  const monthlySummary = useMemo(() => {
    let deposits = 0;
    let closes = 0;
    let depositedUsd = 0;
    for (const cell of monthDays) {
      if (!cell.inMonth) continue;
      const entry = eventsByDate.get(cell.iso);
      if (!entry) continue;
      deposits += entry.deposits;
      closes += entry.closes;
      depositedUsd += entry.depositedUsd;
    }
    return { deposits, closes, depositedUsd };
  }, [monthDays, eventsByDate]);

  const todayIso = isoLocal(today);
  const goPrev = () => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1));
  const goNext = () => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1));
  const goToday = () => setCursor(new Date(today.getFullYear(), today.getMonth(), 1));

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 rounded-full bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary shadow-[inset_0_0_0_1px_hsl(160_84%_45%_/_0.4)]">
          <CalendarIcon className="h-3.5 w-3.5" />
          Activity
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <LegendDot tone="deposit" /> Deposit
          <LegendDot tone="close" /> Close
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
          {monthlySummary.deposits + monthlySummary.closes === 0 ? (
            "No activity this month"
          ) : (
            <span className="font-mono tabular-nums">
              <span className="text-primary">{monthlySummary.deposits}</span>{" "}
              deposit{monthlySummary.deposits === 1 ? "" : "s"}
              {monthlySummary.depositedUsd > 0 && (
                <>
                  {" · "}
                  <span className="text-primary">{fmtUsdCompact(monthlySummary.depositedUsd)}</span>
                  {" deployed"}
                </>
              )}
              {" · "}
              <span className="text-amber-300">{monthlySummary.closes}</span>{" "}
              close{monthlySummary.closes === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>

      {/* Day grid */}
      <div className="flex-1">
        <div className="grid grid-cols-7 gap-1 border-b border-border/60 pb-2">
          {WEEKDAYS.map((d) => (
            <div
              key={d}
              className="text-center text-[10px] uppercase tracking-[0.2em] text-muted-foreground"
            >
              {d}
            </div>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-7 gap-1">
          {monthDays.map((cell, i) => {
            const entry = eventsByDate.get(cell.iso);
            return (
              <DayCell
                key={i}
                day={cell.date.getDate()}
                inMonth={cell.inMonth}
                isToday={cell.iso === todayIso}
                events={entry}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LegendDot({ tone }: { tone: "deposit" | "close" }) {
  const cls =
    tone === "deposit"
      ? "border-primary/50 bg-primary/30"
      : "border-amber-400/50 bg-amber-400/30";
  return <span className={`inline-block h-2 w-2 rounded-full border ${cls}`} />;
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
  // Render up to 6 weeks; trim trailing all-out-of-month rows.
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push({ date: d, inMonth: d.getMonth() === cursor.getMonth(), iso: isoLocal(d) });
  }
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
  events,
}: {
  day: number;
  inMonth: boolean;
  isToday: boolean;
  events: DayEvents | undefined;
}) {
  const hasDeposits = !!events && events.deposits > 0;
  const hasCloses = !!events && events.closes > 0;
  const hasActivity = inMonth && (hasDeposits || hasCloses);

  let toneClass = "border-border/60 bg-background/40 text-muted-foreground";
  if (!inMonth) {
    toneClass = "border-transparent bg-transparent text-muted-foreground/30";
  } else if (hasDeposits && hasCloses) {
    toneClass = "border-primary/30 bg-gradient-to-br from-primary/10 to-amber-500/10";
  } else if (hasDeposits) {
    toneClass = "border-primary/40 bg-primary/10 text-primary";
  } else if (hasCloses) {
    toneClass = "border-amber-500/40 bg-amber-500/10 text-amber-300";
  }

  const titleParts: string[] = [];
  if (hasDeposits) {
    titleParts.push(
      `${events!.deposits} deposit${events!.deposits === 1 ? "" : "s"}` +
        (events!.depositedUsd > 0 ? ` · ${fmtUsdCompact(events!.depositedUsd)}` : ""),
    );
  }
  if (hasCloses) {
    titleParts.push(`${events!.closes} close${events!.closes === 1 ? "" : "s"}`);
  }

  return (
    <div
      title={titleParts.join(" · ") || undefined}
      className={`relative flex aspect-[1.45/1] flex-col justify-between rounded-md border px-2 py-1.5 text-left transition-colors ${toneClass} ${
        isToday ? "ring-1 ring-amber-400/70" : ""
      }`}
    >
      <span
        className={`text-[10px] font-medium tabular-nums ${
          inMonth
            ? isToday
              ? "text-amber-300"
              : "text-foreground/70"
            : "text-muted-foreground/40"
        }`}
      >
        {day}
      </span>

      {hasActivity && (
        <div className="flex flex-col gap-0.5">
          {hasDeposits && (
            <span className="flex items-center gap-1 font-mono text-[10px] font-semibold tabular-nums leading-tight text-primary">
              <ArrowDownToLine className="h-2.5 w-2.5" />
              {events!.depositedUsd > 0
                ? fmtUsdCompact(events!.depositedUsd)
                : `${events!.deposits} dep`}
            </span>
          )}
          {hasCloses && (
            <span className="flex items-center gap-1 font-mono text-[10px] font-semibold tabular-nums leading-tight text-amber-300">
              <ArrowUpFromLine className="h-2.5 w-2.5" />
              {events!.closes} close
            </span>
          )}
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
