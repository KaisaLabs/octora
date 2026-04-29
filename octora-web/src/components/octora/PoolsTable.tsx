import { ArrowUpRight, ShieldEllipsis } from "lucide-react";

import { Pool } from "@/components/octora/types";

interface PoolsTableProps {
  pools: Pool[];
}

export function PoolsTable({ pools }: PoolsTableProps) {
  return (
    <section className="panel-shell rounded-xl p-6 animate-fade-in [animation-delay:300ms]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.26em] text-muted-foreground">Pool router</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Live Meteora opportunities</h2>
        </div>
        <div className="hidden items-center gap-2 rounded-full border border-border/70 bg-secondary/55 px-3 py-1.5 text-sm text-muted-foreground sm:flex">
          <ShieldEllipsis className="h-4 w-4 text-primary" />
          Hidden execution enabled
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-border/70">
        <div className="grid grid-cols-[1.3fr_1fr_0.8fr_0.9fr_0.8fr] gap-4 bg-secondary/60 px-4 py-3 text-xs uppercase tracking-[0.2em] text-muted-foreground">
          <span>Pool</span>
          <span>TVL</span>
          <span>APR</span>
          <span>Depth</span>
          <span className="text-right">Route</span>
        </div>
        <div className="divide-y divide-border/70">
          {pools.map((pool) => (
            <div
              key={pool.id}
              className="grid grid-cols-[1.3fr_1fr_0.8fr_0.9fr_0.8fr] items-center gap-4 bg-card/40 px-4 py-4 transition-colors duration-300 hover:bg-card/70"
            >
              <div>
                <p className="font-medium text-foreground">{pool.name}</p>
                <p className="mt-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">{pool.protocol}</p>
              </div>
              <p className="text-sm text-foreground">{pool.tvl}</p>
              <p className="text-sm text-primary">{pool.apr}</p>
              <div>
                <p className="text-sm text-foreground">{pool.depth}</p>
                <p className="text-xs text-muted-foreground">{pool.risk}</p>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border border-border/80 bg-secondary/55 px-3 py-1.5 text-sm text-foreground transition-all duration-300 hover:border-primary/30 hover:text-primary"
                >
                  Route
                  <ArrowUpRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
