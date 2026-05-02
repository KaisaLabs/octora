import type { PortfolioActivity } from "@/components/octora/types";

interface ActivityPageProps {
  activity: PortfolioActivity[];
}

export function ActivityPage({ activity }: ActivityPageProps) {
  return (
    <section className="panel-shell rounded-2xl p-4 sm:p-6">
      <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Recent activity</p>
      <h2 className="mt-1 text-xl font-semibold text-foreground sm:text-2xl">Session timeline</h2>

      <div className="mt-6 space-y-3">
        {activity.map((item) => (
          <div key={item.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium text-foreground">{item.action}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{item.poolName}</p>
              </div>
              <p className="text-xs text-muted-foreground sm:text-sm">{item.time}</p>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-foreground">{item.value}</span>
              <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-xs text-muted-foreground">
                {item.privacy}
              </span>
            </div>
          </div>
        ))}
      </div>

      {activity.length === 0 && (
        <div className="mt-6 rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No activity yet.
        </div>
      )}
    </section>
  );
}
