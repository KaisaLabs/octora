import { useMemo, useState } from "react";
import { Calculator, Waves } from "lucide-react";

import { Pool } from "@/components/octora/types";
import { Input } from "@/components/ui/input";

interface FeeCalculatorProps {
  pools: Pool[];
}

export function FeeCalculator({ pools }: FeeCalculatorProps) {
  const [deposit, setDeposit] = useState(25000);
  const [selectedPoolId, setSelectedPoolId] = useState(pools[0]?.id ?? "");

  const selectedPool = pools.find((pool) => pool.id === selectedPoolId) ?? pools[0];

  const calculated = useMemo(() => {
    const baseFee = deposit * ((selectedPool?.feeBps ?? 0) / 10000);
    const projectedDaily = baseFee * 7.6;
    const monthly = projectedDaily * 30;
    return {
      entryFee: baseFee,
      projectedDaily,
      projectedMonthly: monthly,
    };
  }, [deposit, selectedPool]);

  return (
    <section className="panel-shell rounded-xl p-6 animate-fade-in [animation-delay:240ms]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.26em] text-muted-foreground">Real-time fee calculator</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Estimate private LP returns</h2>
        </div>
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border/70 bg-secondary/55">
          <Calculator className="text-primary" />
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_0.95fr]">
        <div className="space-y-4">
          <label className="block space-y-2">
            <span className="text-sm text-muted-foreground">Deposit size (USD)</span>
            <Input
              type="number"
              min={1000}
              step={500}
              value={deposit}
              onChange={(event) => setDeposit(Number(event.target.value))}
              className="h-12 border-border/80 bg-secondary/50 text-base"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-3">
            {pools.map((pool) => {
              const active = pool.id === selectedPoolId;
              return (
                <button
                  key={pool.id}
                  type="button"
                  onClick={() => setSelectedPoolId(pool.id)}
                  className={`rounded-xl border p-4 text-left transition-all duration-300 ${
                    active
                      ? "border-primary/40 bg-primary/10 shadow-glow"
                      : "border-border/70 bg-secondary/45 hover:border-border"
                  }`}
                >
                  <p className="text-sm font-medium text-foreground">{pool.name}</p>
                  <p className="mt-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">{pool.protocol}</p>
                  <p className="mt-4 text-sm text-primary">{pool.apr} APR</p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-border/70 bg-secondary/45 p-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Waves className="h-4 w-4 text-primary" />
            Live estimate for {selectedPool?.name}
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-border/70 bg-background/20 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Estimated entry fee</p>
              <p className="mt-2 text-2xl font-semibold text-foreground">${calculated.entryFee.toFixed(2)}</p>
            </div>
            <div className="rounded-xl border border-border/70 bg-background/20 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Projected daily fees</p>
              <p className="mt-2 text-2xl font-semibold text-foreground">${calculated.projectedDaily.toFixed(2)}</p>
            </div>
            <div className="rounded-xl border border-border/70 bg-background/20 p-4 sm:col-span-2">
              <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Projected monthly capture</p>
              <p className="mt-2 text-3xl font-semibold text-gradient">${calculated.projectedMonthly.toFixed(2)}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Simulated with private execution routing and current pool fee bands.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
