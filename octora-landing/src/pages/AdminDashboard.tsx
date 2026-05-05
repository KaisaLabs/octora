import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Users,
  Send,
  Mail,
  LogOut,
  Loader2,
  AlertTriangle,
  Check,
  BarChart3,
  LayoutDashboard,
  RefreshCw,
  ChevronsLeft,
  ChevronsRight,
  TrendingUp,
  ArrowRight,
} from "lucide-react";
import { BentoGrid } from "../components/ui/BentoGrid";
import { GlowBackground } from "../components/GlowBackground";
import { cn } from "../lib/cn";
import { supabase } from "../lib/supabase";
import type { Session } from "@supabase/supabase-js";

type Stats = {
  total: number;
  today: number;
  week: number;
  daily: { day: string; count: number }[];
  sources: { source: string; count: number }[];
};

type WaitlistEntry = {
  id: string;
  email: string;
  source: string | null;
  createdAt: string;
};

type Section = "overview" | "waitlist" | "blast";

async function authFetch(path: string, init?: RequestInit) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token ?? "";
  return fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#EA4335" d="M12 10.2v3.96h5.52a4.71 4.71 0 0 1-2.04 3.09l3.3 2.55c1.92-1.77 3.03-4.38 3.03-7.5 0-.72-.06-1.41-.18-2.1Z" />
      <path fill="#4285F4" d="M12 22c2.7 0 4.95-.9 6.6-2.4l-3.3-2.55c-.9.6-2.04.96-3.3.96-2.55 0-4.71-1.71-5.49-4.02L3.12 16.5A9.99 9.99 0 0 0 12 22Z" transform="translate(0 -.04)" />
      <path fill="#FBBC05" d="M6.51 13.99a5.96 5.96 0 0 1 0-3.99L3.12 7.41a9.99 9.99 0 0 0 0 9.18l3.39-2.6Z" />
      <path fill="#34A853" d="M12 5.98c1.44 0 2.73.5 3.75 1.47l2.79-2.79C16.95 3.06 14.7 2 12 2A9.99 9.99 0 0 0 3.12 7.5l3.39 2.6C7.29 7.7 9.45 5.98 12 5.98Z" />
    </svg>
  );
}

function LoginScreen() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSignIn = () => {
    setLoading(true);
    setError("");
    supabase.auth
      .signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin + "/admin" },
      })
      .catch((e) => {
        setError(e?.message ?? "Sign-in failed.");
        setLoading(false);
      });
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-base px-6">
      <GlowBackground />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-emerald-500/15 bg-emerald-950/30 p-8 backdrop-blur">
        <h1 className="text-2xl font-semibold text-white">Admin Access</h1>
        <p className="mt-2 text-sm text-emerald-100/50">
          Sign in with your team Google account.
        </p>
        {error ? (
          <p className="mt-4 flex items-center gap-2 text-xs text-red-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            {error}
          </p>
        ) : null}
        <button
          onClick={handleSignIn}
          disabled={loading}
          className="mt-6 flex h-12 w-full items-center justify-center gap-3 rounded-full border border-emerald-500/20 bg-white px-5 text-sm font-semibold text-[#031912] transition-colors hover:bg-emerald-50 disabled:opacity-60"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <GoogleIcon className="h-4 w-4" />
              Sign in with Google
            </>
          )}
        </button>
        <p className="mt-4 text-center text-[10px] uppercase tracking-[0.18em] text-emerald-100/30">
          Allowlisted accounts only
        </p>
      </div>
    </div>
  );
}

function Bars({ data }: { data: { day: string; count: number }[] }) {
  const slice = data.slice(-7);
  if (slice.length === 0) {
    return (
      <div className="flex h-full items-end justify-center text-xs text-emerald-100/40">
        No data yet
      </div>
    );
  }
  const max = Math.max(...slice.map((d) => d.count), 1);
  const peakIdx = slice.reduce(
    (best, d, i) => (d.count >= slice[best].count ? i : best),
    0,
  );

  return (
    <div className="flex h-full items-end gap-1.5">
      {slice.map((d, i) => {
        const h = (d.count / max) * 100;
        const isPeak = i === peakIdx;
        return (
          <div
            key={d.day}
            className={cn(
              "flex-1 rounded-t-md transition-colors",
              isPeak ? "bg-emerald-400" : "bg-emerald-500/15",
            )}
            style={{ height: `${Math.max(h, 4)}%` }}
            title={`${d.day}: ${d.count}`}
          />
        );
      })}
    </div>
  );
}

function Sidebar({
  active,
  onSelect,
  onSignOut,
  collapsed,
  onToggleCollapsed,
  email,
}: {
  active: Section;
  onSelect: (s: Section) => void;
  onSignOut: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  email: string;
}) {
  const items: { key: Section; label: string; Icon: typeof Users }[] = [
    { key: "overview", label: "Overview", Icon: LayoutDashboard },
    { key: "waitlist", label: "Waitlist", Icon: Users },
    { key: "blast", label: "Email Blast", Icon: Send },
  ];

  return (
    <aside
      className={cn(
        "relative z-10 flex w-full shrink-0 flex-col gap-1 border-emerald-500/10 bg-emerald-950/20 backdrop-blur transition-[width] duration-200 ease-out lg:h-screen lg:border-r lg:sticky lg:top-0",
        collapsed ? "lg:w-16" : "lg:w-60",
        "px-3 py-6 lg:px-3",
      )}
    >
      <div
        className={cn(
          "flex items-center pb-6",
          collapsed ? "lg:justify-center lg:px-0" : "px-2",
        )}
      >
        {collapsed ? (
          <div className="hidden h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-sm font-semibold text-emerald-300 lg:flex">
            O
          </div>
        ) : null}
        <div className={cn("min-w-0", collapsed ? "lg:hidden" : "")}>
          <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-emerald-100/50">
            Octora
          </p>
          <p className="mt-1 text-sm font-semibold text-white">Admin</p>
          <p className="mt-0.5 truncate text-[10px] text-emerald-100/40" title={email}>
            {email}
          </p>
        </div>
      </div>

      <nav className="flex flex-1 flex-row gap-1 lg:flex-col">
        {items.map(({ key, label, Icon }) => {
          const isActive = active === key;
          return (
            <button
              key={key}
              onClick={() => onSelect(key)}
              title={collapsed ? label : undefined}
              className={cn(
                "flex flex-1 items-center gap-2.5 rounded-lg py-2 text-xs font-medium transition-colors lg:flex-none",
                collapsed ? "lg:justify-center lg:px-0" : "px-3",
                "px-3",
                isActive
                  ? "bg-emerald-500/15 text-white"
                  : "text-emerald-100/60 hover:bg-emerald-500/5 hover:text-white",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className={cn("truncate", collapsed ? "lg:hidden" : "")}>
                {label}
              </span>
            </button>
          );
        })}
      </nav>

      <button
        onClick={onSignOut}
        title={collapsed ? "Sign out" : undefined}
        className={cn(
          "mt-2 flex items-center gap-2.5 rounded-lg py-2 text-xs font-medium text-emerald-100/60 transition-colors hover:bg-emerald-500/5 hover:text-white lg:mt-auto",
          collapsed ? "lg:justify-center lg:px-0" : "px-3",
          "px-3",
        )}
      >
        <LogOut className="h-4 w-4 shrink-0" />
        <span className={cn(collapsed ? "lg:hidden" : "")}>Sign out</span>
      </button>

      <button
        onClick={onToggleCollapsed}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className={cn(
          "mt-2 hidden h-8 items-center gap-2 rounded-lg text-xs text-emerald-100/40 transition-colors hover:bg-emerald-500/5 hover:text-white lg:flex",
          collapsed ? "justify-center px-0" : "justify-end px-3",
        )}
      >
        {collapsed ? (
          <ChevronsRight className="h-4 w-4" />
        ) : (
          <ChevronsLeft className="h-4 w-4" />
        )}
      </button>
    </aside>
  );
}

function StatCard({
  label,
  value,
  children,
}: {
  label: string;
  value: number | string;
  children?: ReactNode;
}) {
  return (
    <div className="col-span-3 flex flex-col justify-between rounded-2xl border border-emerald-500/10 bg-emerald-950/30 p-5 sm:col-span-1">
      <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-emerald-100/40">
        {label}
      </p>
      <div>
        <p className="text-5xl font-semibold tracking-tight text-white">{value}</p>
        {children ? <div className="mt-3">{children}</div> : null}
      </div>
    </div>
  );
}

function OverviewSection({
  stats,
  entries,
  onOpenBlast,
  onOpenWaitlist,
}: {
  stats: Stats;
  entries: WaitlistEntry[];
  onOpenBlast: () => void;
  onOpenWaitlist: () => void;
}) {
  const peakDaily = Math.max(...stats.daily.map((d) => d.count), 1);
  const todayPct = Math.min((stats.today / peakDaily) * 100, 100);
  const weekDelta = stats.total > 0 ? (stats.week / stats.total) * 100 : 0;
  const recent = entries.slice(0, 3);

  return (
    <BentoGrid>
      {/* Total Waitlist */}
      <StatCard label="Total Waitlist" value={stats.total.toLocaleString()}>
        <p className="inline-flex items-center gap-1 text-xs font-medium text-emerald-300">
          <TrendingUp className="h-3.5 w-3.5" />
          {weekDelta.toFixed(1)}% this week
        </p>
      </StatCard>

      {/* Active Today */}
      <StatCard label="Active Today" value={stats.today}>
        <div className="h-1 w-full overflow-hidden rounded-full bg-emerald-500/10">
          <div
            className="h-full bg-emerald-400 transition-all duration-500"
            style={{ width: `${todayPct}%` }}
          />
        </div>
      </StatCard>

      {/* Traffic chart - tall right column */}
      <div className="col-span-3 row-span-2 flex flex-col rounded-2xl border border-emerald-500/10 bg-emerald-950/30 p-5 lg:col-span-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-emerald-400" />
            <h3 className="text-sm font-semibold text-white">Traffic Velocity</h3>
          </div>
          <span className="rounded-md border border-emerald-500/15 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-emerald-100/50">
            Last 7 Days
          </span>
        </div>

        <div className="mt-6 flex-1">
          <Bars data={stats.daily} />
        </div>

        <div className="mt-4 grid grid-cols-3 gap-3 border-t border-emerald-500/10 pt-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-emerald-100/40">
              Total
            </p>
            <p className="mt-1 text-lg font-semibold text-white">{stats.total}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-emerald-100/40">
              Week
            </p>
            <p className="mt-1 text-lg font-semibold text-white">{stats.week}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-emerald-100/40">
              Rate
            </p>
            <p className="mt-1 text-lg font-semibold text-white">
              {(stats.week / 7).toFixed(1)}/d
            </p>
          </div>
        </div>
      </div>

      {/* Blast CTA - subdued emerald accent */}
      <div className="relative col-span-3 overflow-hidden rounded-2xl border border-emerald-400/15 bg-gradient-to-br from-emerald-600/15 to-emerald-800/25 p-5 lg:col-span-2">
        <div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            backgroundImage:
              "radial-gradient(circle at 85% 0%, rgba(16,185,129,0.18), transparent 55%)",
          }}
        />
        <div className="relative">
          <h3 className="text-2xl font-semibold tracking-tight text-white">
            Blast Update
          </h3>
          <p className="mt-1 max-w-md text-sm text-emerald-100/60">
            Ready to send the next batch of invites? {stats.total} user
            {stats.total === 1 ? "" : "s"} waiting for the next update.
          </p>

          <div className="mt-4 rounded-xl border border-emerald-400/15 bg-emerald-500/[0.06] p-3">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-emerald-100/50">
                Live Segment
              </p>
              <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] tracking-wider text-emerald-200">
                BATCH_01
              </span>
            </div>
            <p className="mt-1 text-sm font-semibold text-white">
              Waitlist Members ({stats.total})
            </p>
          </div>

          <button
            onClick={onOpenBlast}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500/90 px-5 py-2.5 text-sm font-semibold text-[#031912] transition-colors hover:bg-emerald-400"
          >
            <Send className="h-4 w-4" />
            Deploy Campaign
          </button>
        </div>
      </div>

      {/* Waitlist Registry preview */}
      <div className="col-span-3 rounded-2xl border border-emerald-500/10 bg-emerald-950/30 p-5 lg:col-span-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-emerald-400" />
            <h3 className="text-[10px] font-medium uppercase tracking-[0.2em] text-emerald-100/40">
              Waitlist Registry
            </h3>
          </div>
          <button
            onClick={onOpenWaitlist}
            className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-300 transition-colors hover:text-emerald-200"
          >
            View All Registry
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>

        <ul className="mt-4 divide-y divide-emerald-500/5">
          {recent.length === 0 ? (
            <li className="py-3 text-xs text-emerald-100/40">No signups yet</li>
          ) : (
            recent.map((e) => {
              const initials = e.email.slice(0, 2).toUpperCase();
              return (
                <li
                  key={e.id}
                  className="flex items-center gap-3 py-2.5 text-xs"
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 font-mono text-[10px] font-semibold text-emerald-300">
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-white">{e.email}</p>
                    <p className="truncate text-[10px] uppercase tracking-[0.15em] text-emerald-100/40">
                      {e.source ?? "Unknown source"}
                    </p>
                  </div>
                  <p className="shrink-0 font-mono text-[10px] text-emerald-100/40">
                    {new Date(e.createdAt).toLocaleDateString(undefined, {
                      month: "2-digit",
                      day: "2-digit",
                    })}
                  </p>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </BentoGrid>
  );
}

function WaitlistSection({ entries }: { entries: WaitlistEntry[] }) {
  return (
    <div className="rounded-2xl border border-emerald-500/15 bg-emerald-950/20">
      <div className="flex items-center justify-between border-b border-emerald-500/10 px-5 py-3">
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-emerald-400" />
          <h2 className="text-sm font-semibold text-white">Recent Signups</h2>
        </div>
        <span className="text-xs text-emerald-100/40">{entries.length} shown</span>
      </div>
      <div className="max-h-[60vh] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-emerald-950/60 backdrop-blur">
            <tr className="text-left text-emerald-100/50">
              <th className="px-5 py-2 font-medium">Email</th>
              <th className="px-5 py-2 font-medium">Source</th>
              <th className="px-5 py-2 text-right font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr
                key={e.id}
                className="border-t border-emerald-500/5 text-emerald-100/80"
              >
                <td className="px-5 py-2.5 font-mono">{e.email}</td>
                <td className="px-5 py-2.5 text-emerald-100/50">{e.source ?? "—"}</td>
                <td className="px-5 py-2.5 text-right font-mono text-emerald-100/40">
                  {new Date(e.createdAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BlastSection() {
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [blastState, setBlastState] = useState<"idle" | "sending" | "done" | "error">(
    "idle",
  );
  const [blastResult, setBlastResult] = useState<{
    total?: number;
    sent?: number;
    failed?: number;
    message?: string;
  } | null>(null);

  const previewCount = useCallback(() => {
    setBlastResult(null);
    authFetch("/api/admin/blast", {
      method: "POST",
      body: JSON.stringify({
        subject: subject || "preview",
        html: html || "preview body",
        source: sourceFilter || undefined,
        dryRun: true,
      }),
    })
      .then((r) => r.json())
      .then((data) => setBlastResult({ total: data.count }))
      .catch(() => setBlastResult({ message: "Preview failed" }));
  }, [subject, html, sourceFilter]);

  const sendBlast = useCallback(() => {
    if (!subject.trim() || !html.trim()) return;
    if (
      !confirm(
        `Send "${subject}" to ${
          sourceFilter ? `source=${sourceFilter}` : "ALL"
        } waitlist users? This cannot be undone.`,
      )
    )
      return;
    setBlastState("sending");
    setBlastResult(null);
    authFetch("/api/admin/blast", {
      method: "POST",
      body: JSON.stringify({
        subject,
        html,
        source: sourceFilter || undefined,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setBlastState("error");
          setBlastResult({ message: data.error });
        } else {
          setBlastState("done");
          setBlastResult({ total: data.total, sent: data.sent, failed: data.failed });
        }
      })
      .catch(() => {
        setBlastState("error");
        setBlastResult({ message: "Network error" });
      });
  }, [subject, html, sourceFilter]);

  return (
    <div className="rounded-2xl border border-emerald-500/15 bg-emerald-950/20 p-5">
      <div className="flex items-center gap-2">
        <Send className="h-4 w-4 text-emerald-400" />
        <h2 className="text-sm font-semibold text-white">Compose Blast</h2>
      </div>
      <p className="mt-1 text-xs text-emerald-100/50">
        Send a message to the waitlist. Use the preview button to count recipients before sending.
      </p>

      <div className="mt-5 flex flex-col gap-3">
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject"
          className="h-10 w-full rounded-lg border border-emerald-500/15 bg-emerald-950/40 px-3 text-sm text-white placeholder-emerald-100/30 outline-none focus:border-emerald-500/40"
        />
        <textarea
          value={html}
          onChange={(e) => setHtml(e.target.value)}
          placeholder="HTML body — e.g. <h1>Hello</h1><p>...</p>"
          rows={10}
          className="w-full resize-y rounded-lg border border-emerald-500/15 bg-emerald-950/40 p-3 font-mono text-xs text-white placeholder-emerald-100/30 outline-none focus:border-emerald-500/40"
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="text"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            placeholder="Filter by source (blank = ALL)"
            className="h-10 flex-1 rounded-lg border border-emerald-500/15 bg-emerald-950/40 px-3 text-xs text-white placeholder-emerald-100/30 outline-none focus:border-emerald-500/40"
          />
          <button
            type="button"
            onClick={previewCount}
            className="h-10 rounded-lg border border-emerald-500/20 px-4 text-xs font-semibold text-emerald-100/80 transition-colors hover:bg-emerald-500/10"
          >
            Preview count
          </button>
          <button
            type="button"
            onClick={sendBlast}
            disabled={blastState === "sending" || !subject || !html}
            className="flex h-10 items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 text-xs font-semibold text-[#010504] transition-colors hover:bg-emerald-400 disabled:opacity-50"
          >
            {blastState === "sending" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                <Send className="h-3.5 w-3.5" />
                Send blast
              </>
            )}
          </button>
        </div>
        {blastResult ? (
          <div
            className={cn(
              "rounded-lg border px-3 py-2 text-xs",
              blastState === "error"
                ? "border-red-500/30 bg-red-500/10 text-red-300"
                : "border-emerald-500/20 bg-emerald-500/5 text-emerald-200",
            )}
          >
            {blastState === "done" ? (
              <span className="inline-flex items-center gap-2">
                <Check className="h-3.5 w-3.5" />
                Sent {blastResult.sent} / {blastResult.total} · {blastResult.failed} failed
              </span>
            ) : blastResult.total !== undefined ? (
              <>Will send to {blastResult.total} recipient(s).</>
            ) : (
              blastResult.message
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Dashboard({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loadError, setLoadError] = useState("");
  const [section, setSection] = useState<Section>("overview");
  const [refreshing, setRefreshing] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem("octora_admin_sidebar_collapsed") === "1",
  );

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem("octora_admin_sidebar_collapsed", next ? "1" : "0");
      return next;
    });
  }, []);

  const loadAll = useCallback(() => {
    setRefreshing(true);
    setLoadError("");
    const parse = async (r: Response) => {
      if (r.status === 403) throw new Error("This account isn't on the admin allowlist.");
      if (r.status === 401) throw new Error("Session expired. Please sign in again.");
      if (!r.ok) {
        const msg = await r
          .json()
          .then((d) => d.error)
          .catch(() => null);
        throw new Error(msg ?? "Failed to load admin data.");
      }
      return r.json();
    };
    Promise.all([
      authFetch("/api/admin/stats").then(parse),
      authFetch("/api/admin/waitlist?limit=200").then(parse),
    ])
      .then(([s, w]) => {
        setStats(s);
        setEntries(w.entries ?? []);
      })
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const sectionTitle = useMemo(
    () =>
      ({
        overview: "Overview",
        waitlist: "Waitlist",
        blast: "Email Blast",
      })[section],
    [section],
  );

  if (loadError) {
    return (
      <div className="relative flex min-h-screen items-center justify-center bg-base px-6 text-white">
        <div className="text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-amber-400" />
          <p className="mt-4 text-sm">{loadError}</p>
          <button
            onClick={onSignOut}
            className="mt-4 rounded-full border border-emerald-500/20 px-4 py-2 text-xs"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="relative flex min-h-screen items-center justify-center bg-base text-white">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-base text-white">
      <GlowBackground />
      <div className="relative z-10 flex min-h-screen flex-col lg:flex-row">
        <Sidebar
          active={section}
          onSelect={setSection}
          onSignOut={onSignOut}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          email={email}
        />

        <main className="flex-1 px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
          <header className="mb-6 flex items-center justify-between">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-emerald-100/50">
                Dashboard
              </p>
              <h1 className="mt-0.5 text-xl font-semibold tracking-tight">
                {sectionTitle}
              </h1>
            </div>
            <button
              onClick={loadAll}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 px-3 py-1.5 text-xs text-emerald-100/70 transition-colors hover:border-emerald-500/40 hover:text-white disabled:opacity-50"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
              Refresh
            </button>
          </header>

          {section === "overview" && (
            <OverviewSection
              stats={stats}
              entries={entries}
              onOpenBlast={() => setSection("blast")}
              onOpenWaitlist={() => setSection("waitlist")}
            />
          )}
          {section === "waitlist" && <WaitlistSection entries={entries} />}
          {section === "blast" && <BlastSection />}
        </main>
      </div>
    </div>
  );
}

export function AdminDashboard() {
  const [session, setSession] = useState<Session | null>(null);
  const [bootstrapping, setBootstrapping] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setBootstrapping(false);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, s) => setSession(s),
    );
    return () => subscription.subscription.unsubscribe();
  }, []);

  if (bootstrapping) {
    return (
      <div className="relative flex min-h-screen items-center justify-center bg-base text-white">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-400" />
      </div>
    );
  }

  if (!session?.user?.email) {
    return <LoginScreen />;
  }

  return (
    <Dashboard
      email={session.user.email}
      onSignOut={() => {
        supabase.auth.signOut();
      }}
    />
  );
}
