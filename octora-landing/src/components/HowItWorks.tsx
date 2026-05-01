import { ScrollReveal } from "./ScrollReveal";
import { Wallet, Shuffle, Ghost, Droplets } from "lucide-react";
import { motion } from "framer-motion";
import type { ReactNode } from "react";

const steps: {
  label: string;
  sub: string;
  icon: ReactNode;
}[] = [
  {
    label: "Your Wallet",
    sub: "Origin stays hidden",
    icon: <Wallet className="h-6 w-6 text-emerald-400" />,
  },
  {
    label: "Octora Mixer",
    sub: "ZK proof + relay",
    icon: <Shuffle className="h-6 w-6 text-emerald-400" />,
  },
  {
    label: "Stealth Address",
    sub: "Unlinkable session",
    icon: <Ghost className="h-6 w-6 text-emerald-400" />,
  },
  {
    label: "Meteora Pool",
    sub: "LP deposited privately",
    icon: <Droplets className="h-6 w-6 text-emerald-400" />,
  },
];

function AnimatedConnector({ delay }: { delay: number }) {
  return (
    <div className="flex flex-col items-center">
      {/* Top dot */}
      <div className="h-2 w-2 rounded-full bg-emerald-400/50 shadow-[0_0_6px_rgba(16,185,129,0.4)]" />
      {/* Line */}
      <div className="relative h-8 w-[2px] bg-emerald-500/15 overflow-hidden">
        <motion.div
          className="absolute top-0 left-0 h-4 w-full bg-emerald-400/70"
          animate={{ top: ["0%", "100%"] }}
          transition={{
            duration: 1.2,
            repeat: Infinity,
            ease: "linear",
            delay,
          }}
        />
      </div>
      {/* Bottom dot */}
      <div className="h-2 w-2 rounded-full bg-emerald-400/50 shadow-[0_0_6px_rgba(16,185,129,0.4)]" />
    </div>
  );
}

export function HowItWorks() {
  return (
    <section
      id="how"
      className="border-t border-emerald-500/10 px-6 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.2fr]">
          {/* Left — heading */}
          <ScrollReveal>
            <p className="mb-4 text-xs font-medium uppercase tracking-[0.22em] text-emerald-100/50">
              How it works
            </p>
            <h2 className="text-4xl font-bold tracking-tight text-white sm:text-5xl">
              From <span className="text-emerald-400">wallet to pool</span>,
              <br />
              without{" "}
              <span className="text-emerald-400">leaving a trace</span>.
            </h2>
            <p className="mt-5 max-w-sm text-base leading-7 text-emerald-100/40">
              Your deposit is routed through a ZK mixer and a stealth address so
              the Meteora pool never sees your origin wallet.
            </p>
          </ScrollReveal>

          {/* Right — flow diagram */}
          <ScrollReveal delay={0.15}>
            <div className="mx-auto flex max-w-[400px] flex-col">
              {steps.map((step, i) => (
                <div key={step.label}>
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.4, delay: i * 0.12 }}
                    className="flex w-full items-center gap-5 rounded-2xl border border-emerald-500/15 bg-emerald-950/60 px-6 py-5 backdrop-blur-sm"
                  >
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-emerald-500/15 bg-emerald-500/10">
                      {step.icon}
                    </div>
                    <div>
                      <p className="text-lg font-semibold text-white">
                        {step.label}
                      </p>
                      <p className="text-sm leading-tight text-emerald-100/40">
                        {step.sub}
                      </p>
                    </div>
                  </motion.div>

                  {i < steps.length - 1 && (
                    <AnimatedConnector delay={i * 0.4} />
                  )}
                </div>
              ))}
            </div>
          </ScrollReveal>
        </div>
      </div>
    </section>
  );
}
