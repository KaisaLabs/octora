import { Wallet, Search, SlidersHorizontal, ShieldCheck } from "lucide-react";
import { ScrollReveal } from "./ScrollReveal";
import { motion } from "framer-motion";

const steps = [
  {
    n: "01",
    icon: Wallet,
    title: "Connect wallet",
    desc: "Open a private session — your main wallet stays shielded.",
  },
  {
    n: "02",
    icon: Search,
    title: "Pick a pool",
    desc: "Search pairs, paste a CA, or browse trending Meteora pools.",
  },
  {
    n: "03",
    icon: SlidersHorizontal,
    title: "Set strategy",
    desc: "Choose range, allocation, and concentration like Meteora.",
  },
  {
    n: "04",
    icon: ShieldCheck,
    title: "Deposit privately",
    desc: "Routed through Vanish + MagicBlock — copy bots see nothing.",
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="border-t border-emerald-500/10 px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <ScrollReveal className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-medium uppercase tracking-[0.22em] text-emerald-100/50">
            How it works
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            From wallet to pool — without leaving a trace.
          </h2>
        </ScrollReveal>

        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {steps.map((s, i) => (
            <motion.div
              key={s.n}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.12 }}
              className="flex flex-col rounded-2xl border border-emerald-500/10 bg-emerald-950/20 p-6"
            >
              <div className="flex items-center gap-3">
                <span className="font-mono text-xs text-emerald-400/60">
                  {s.n}
                </span>
                <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-500/15 bg-emerald-500/5">
                  <s.icon className="h-4 w-4 text-emerald-400" />
                </div>
              </div>
              <h3 className="mt-4 text-base font-semibold text-white">
                {s.title}
              </h3>
              <p className="mt-2 text-sm leading-6 text-emerald-100/50">
                {s.desc}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
