import { ArrowRight, EyeOff, Layers3, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";

type HeroStat = {
  label: string;
  value: string;
  change: string;
};

interface OctoraHeroProps {
  stats: HeroStat[];
}

export function OctoraHero({ stats }: OctoraHeroProps) {
  return (
    <section className="relative overflow-hidden py-12 sm:py-16">
      <div className="container grid gap-8 lg:grid-cols-[1.2fr_0.8fr] lg:items-end">
        <div className="space-y-8 animate-fade-in">
          <div className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-secondary/70 px-3 py-1.5 text-xs uppercase tracking-[0.24em] text-muted-foreground">
            <EyeOff className="h-3.5 w-3.5 text-primary" />
            Vanish + MagicBlock active
          </div>

          <div className="max-w-3xl space-y-4">
            <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
              Private liquidity execution for <span className="text-gradient">Meteora pools</span>
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-muted-foreground">
              Add liquidity into DLMM and DAMM strategies with hidden origin wallet routing, protected submission,
              and execution that stays invisible to copy-trade bots.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button variant="hero" size="pill">
              Start protected session
              <ArrowRight />
            </Button>
            <Button variant="subtle" size="pill">
              <Layers3 />
              Review pool bands
            </Button>
          </div>
        </div>

        <div className="panel-shell relative overflow-hidden rounded-xl p-6 animate-fade-in [animation-delay:120ms]">
          <div className="absolute inset-0 grid-fade opacity-60" aria-hidden="true" />
          <div className="relative space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.26em] text-muted-foreground">Protected capital</p>
                <p className="mt-2 text-3xl font-semibold text-foreground">$248,920</p>
              </div>
              <div className="flex h-12 w-12 animate-float items-center justify-center rounded-full border border-primary/25 bg-primary/10">
                <Zap className="text-primary" />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {stats.map((stat) => (
                <div key={stat.label} className="rounded-xl border border-border/70 bg-secondary/45 p-4 motion-safe-lift">
                  <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{stat.label}</p>
                  <p className="mt-3 text-xl font-semibold text-foreground">{stat.value}</p>
                  <p className="mt-1 text-sm text-primary">{stat.change}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
