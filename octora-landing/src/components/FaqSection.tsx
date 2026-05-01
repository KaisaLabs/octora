import { ScrollReveal } from "./ScrollReveal";
import { motion } from "framer-motion";

const faqs = [
  {
    q: "How does Octora hide my main wallet?",
    a: "Octora opens a session wallet and routes deposit intents through Vanish + MagicBlock relays. The Meteora pool only sees the session, never your main address.",
  },
  {
    q: "Which pools are supported?",
    a: "All Meteora DLMM and DAMM pools. You can paste a contract address or pick from trending pairs.",
  },
  {
    q: "Do I keep custody?",
    a: "Yes. Session wallets are non-custodial and can be revoked at any time from the app.",
  },
  {
    q: "Are fees and rewards claimable?",
    a: "Yes. Claim, withdraw, or rebalance from inside the app — all through the same private route.",
  },
];

export function FaqSection() {
  return (
    <section id="faq" className="border-t border-emerald-500/10 px-6 py-20 sm:py-28">
      <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[0.9fr_1.1fr]">
        <ScrollReveal>
          <p className="text-xs font-medium uppercase tracking-[0.22em] text-emerald-100/50">
            FAQ
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Common questions.
          </h2>
          <p className="mt-3 max-w-md text-sm leading-7 text-emerald-100/50">
            Octora is non-custodial. You always control your funds — we just
            shield the path between you and the pool.
          </p>
        </ScrollReveal>

        <div className="space-y-3">
          {faqs.map((f, i) => (
            <motion.details
              key={f.q}
              initial={{ opacity: 0, x: 20 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: i * 0.08 }}
              className="group rounded-xl border border-emerald-500/10 bg-emerald-950/20 p-5 open:border-emerald-500/25"
            >
              <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium text-white">
                {f.q}
                <span className="shrink-0 text-emerald-100/40 transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm leading-6 text-emerald-100/50">
                {f.a}
              </p>
            </motion.details>
          ))}
        </div>
      </div>
    </section>
  );
}
