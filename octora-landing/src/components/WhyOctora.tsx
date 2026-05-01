import { EyeOff, Layers3, Route, Zap } from "lucide-react";
import { ScrollReveal } from "./ScrollReveal";
import type { LucideIcon } from "lucide-react";

const features: { icon: LucideIcon; title: string; desc: string }[] = [
  {
    icon: EyeOff,
    title: "Hidden origin wallet",
    desc: "Your main wallet never touches the pool. Session keys execute on your behalf.",
  },
  {
    icon: Route,
    title: "Private execution route",
    desc: "Vanish + MagicBlock relay your intent before it reaches Meteora.",
  },
  {
    icon: Layers3,
    title: "DLMM & DAMM pools",
    desc: "Full access to Meteora's liquidity primitives with Meteora-style strategy setup.",
  },
  {
    icon: Zap,
    title: "Fast in-app deposits",
    desc: "Search, configure, deposit. Built for mobile and desktop trading flows.",
  },
];

export function WhyOctora() {
  return (
    <section className="relative py-20">
      <ScrollReveal direction="up">
        <div className="mx-auto max-w-2xl px-6 text-center">
          <p className="text-xs uppercase tracking-[0.22em] text-emerald-400/50">
            Why Octora
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Built for traders who don't want to be watched.
          </h2>
        </div>
      </ScrollReveal>

      <div className="mx-auto mt-12 grid max-w-5xl grid-cols-1 gap-4 px-6 sm:grid-cols-2">
        {features.map((f, i) => (
          <ScrollReveal key={f.title} direction="up" delay={i * 0.1}>
            <div className="flex flex-col rounded-2xl border border-emerald-500/12 bg-emerald-500/5 p-6 backdrop-blur-sm transition-colors hover:border-emerald-500/25 hover:bg-emerald-500/10">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-emerald-500/10 bg-emerald-500/8">
                <f.icon className="h-5 w-5 text-emerald-400" />
              </div>
              <h3 className="mt-4 text-base font-semibold text-white">
                {f.title}
              </h3>
              <p className="mt-2 text-sm leading-6 text-emerald-100/50">
                {f.desc}
              </p>
            </div>
          </ScrollReveal>
        ))}
      </div>
    </section>
  );
}
