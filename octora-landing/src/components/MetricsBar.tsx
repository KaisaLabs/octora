import { ScrollReveal } from "./ScrollReveal";

const stats = [
  { label: "Protected TVL", value: "$2.4M" },
  { label: "Private Sessions", value: "1,280" },
  { label: "Fees Captured", value: "$184K" },
  { label: "Active Positions", value: "342" },
];

export function MetricsBar() {
  return (
    <section className="border-y border-emerald-500/10">
      <ScrollReveal>
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-6 px-6 py-10 sm:grid-cols-4 sm:py-14">
          {stats.map((s) => (
            <div key={s.label} className="text-center">
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-emerald-100/40">
                {s.label}
              </p>
              <p className="mt-2 bg-gradient-to-b from-white to-emerald-200/60 bg-clip-text text-3xl font-bold text-transparent sm:text-4xl">
                {s.value}
              </p>
            </div>
          ))}
        </div>
      </ScrollReveal>
    </section>
  );
}
