import type { PortfolioPosition } from "@/components/octora/types";
import { Button } from "@/components/ui/button";

interface PortfolioPageProps {
  positions: PortfolioPosition[];
}

export function PortfolioPage({ positions }: PortfolioPageProps) {
  return (
    <section className="panel-shell rounded-2xl p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">Open positions</p>
          <h2 className="mt-1 text-xl font-semibold text-foreground sm:text-2xl">Your private LP</h2>
        </div>
      </div>

      {/* Desktop table */}
      <div className="mt-6 hidden overflow-hidden rounded-xl border border-border lg:block">
        <div className="grid grid-cols-[1.4fr_1fr_1fr_1fr_0.8fr_140px] gap-4 bg-secondary/60 px-4 py-3 text-xs uppercase tracking-[0.18em] text-muted-foreground">
          <span>Pool</span>
          <span>Deposited</span>
          <span>Value</span>
          <span>Fees</span>
          <span>Status</span>
          <span className="text-right">Manage</span>
        </div>
        <div className="divide-y divide-border">
          {positions.map((p) => (
            <div key={p.id} className="grid grid-cols-[1.4fr_1fr_1fr_1fr_0.8fr_140px] items-center gap-4 bg-card px-4 py-4 text-sm">
              <div>
                <p className="font-medium text-foreground">{p.poolName}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{p.protocol}</p>
              </div>
              <p className="text-foreground">{p.deposited}</p>
              <p className="text-foreground">{p.value}</p>
              <p className="text-primary">{p.feesEarned}</p>
              <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-xs text-foreground">{p.status}</span>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="premium">Claim</Button>
                <Button size="sm" variant="subtle">Withdraw</Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Mobile cards */}
      <div className="mt-6 grid gap-3 lg:hidden">
        {positions.map((p) => (
          <div key={p.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-base font-semibold text-foreground">{p.poolName}</p>
                <p className="mt-0.5 text-xs uppercase tracking-[0.18em] text-muted-foreground">{p.protocol}</p>
              </div>
              <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-xs text-foreground">{p.status}</span>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Deposited</p>
                <p className="mt-0.5 text-foreground">{p.deposited}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Value</p>
                <p className="mt-0.5 text-foreground">{p.value}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Fees</p>
                <p className="mt-0.5 text-primary">{p.feesEarned}</p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Button size="sm" variant="premium" className="w-full">Claim</Button>
              <Button size="sm" variant="subtle" className="w-full">Withdraw</Button>
            </div>
          </div>
        ))}
      </div>

      {positions.length === 0 && (
        <div className="mt-6 rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No open positions yet.
        </div>
      )}
    </section>
  );
}
