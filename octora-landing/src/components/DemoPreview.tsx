import { Play } from "lucide-react";
import { ScrollReveal } from "./ScrollReveal";

export function DemoPreview() {
  return (
    <section id="demo" className="px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-4xl">
        <ScrollReveal className="text-center">
          <p className="text-xs font-medium uppercase tracking-[0.22em] text-emerald-100/50">
            Demo
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            See Octora in action.
          </h2>
          <p className="mt-3 text-sm leading-7 text-emerald-100/50">
            Private LP execution on Meteora — coming soon.
          </p>
        </ScrollReveal>

        <ScrollReveal delay={0.15}>
          <div className="animate-glow-pulse relative mt-10 overflow-hidden rounded-2xl border border-emerald-500/10 bg-emerald-950/20">
            {/* Fake app mockup */}
            <div className="flex flex-col items-center justify-center py-24 sm:py-32">
              {/* Play icon */}
              <div className="flex h-16 w-16 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/10">
                <Play className="h-6 w-6 text-emerald-400" />
              </div>
              <p className="mt-6 text-sm font-medium tracking-[0.1em] uppercase text-emerald-100/40">
                Demo Coming Soon
              </p>

              {/* Decorative terminal lines */}
              <div className="mt-8 w-full max-w-sm space-y-2 px-6">
                <div className="h-2 w-3/4 rounded bg-emerald-500/5" />
                <div className="h-2 w-full rounded bg-emerald-500/5" />
                <div className="h-2 w-5/6 rounded bg-emerald-500/5" />
                <div className="h-2 w-2/3 rounded bg-emerald-500/5" />
              </div>
            </div>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
