import { ArrowRight, EyeOff, Layers3, Lock, Route, Sparkles, Zap } from "lucide-react";
import { Link } from "react-router-dom";

import { AppFooter } from "@/components/octora/AppFooter";
import { AppHeader } from "@/components/octora/AppHeader";
import { Button } from "@/components/ui/button";
import { ScrollReveal } from "@/components/landing/ScrollReveal";
import { LogoMarquee } from "@/components/landing/LogoMarquee";
import { footerLinks, pools, portfolioSummary } from "@/data/octora";

const features = [
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

const steps = [
  { n: "01", title: "Connect wallet", desc: "Open a private session — your main wallet stays shielded." },
  { n: "02", title: "Pick a pool", desc: "Search pairs, paste a CA, or browse trending Meteora pools." },
  { n: "03", title: "Set strategy", desc: "Choose range, allocation, and concentration like Meteora." },
  { n: "04", title: "Deposit privately", desc: "Routed through Vanish + MagicBlock — copy bots see nothing." },
];

const stats = [
  { label: "Protected TVL", value: portfolioSummary.totalValue },
  { label: "Private sessions", value: String(portfolioSummary.privateSessions) },
  { label: "Fees captured", value: portfolioSummary.totalFees },
  { label: "Active positions", value: String(portfolioSummary.activePositions) },
];

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

const Index = () => {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 z-0 opacity-40" aria-hidden="true">
        <div className="absolute left-0 right-0 top-0 h-[520px] grid-fade" />
      </div>

      <AppHeader />

      <main className="relative z-10">
        {/* ─── HERO ─────────────────────────────────────────────── */}
        <section className="container flex flex-col items-center py-16 sm:py-24 lg:py-32">
          <ScrollReveal direction="up" delay={0} className="flex flex-col items-center text-center">
            {/* Badge */}
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 backdrop-blur-sm">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs font-medium tracking-[0.16em] text-primary">
                PRIVACY LAYER FOR METEORA
              </span>
            </div>

            <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-6xl xl:text-7xl">
              Add liquidity to Meteora
              <br />
               <span className="text-primary">
                privately.
              </span>
            </h1>

            <p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
              Octora hides your origin wallet so copy-trade bots can't track your moves.
              Search, deposit, claim, and withdraw from one clean interface.
            </p>

            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Button asChild variant="hero" size="pill" className="text-base">
                <Link to="/app">
                  Launch app
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button asChild variant="subtle" size="pill">
                <a href="#how">How it works</a>
              </Button>
            </div>
          </ScrollReveal>
        </section>

        {/* ─── STATS BAR ───────────────────────────────────────── */}
        <ScrollReveal direction="up">
          <section className="border-y border-border/70 bg-card/40">
            <div className="container grid grid-cols-2 gap-6 py-8 sm:grid-cols-4">
              {stats.map((s) => (
                <div key={s.label}>
                  <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                    {s.label}
                  </p>
                  <p className="mt-2 text-2xl font-semibold text-foreground sm:text-3xl">
                    {s.value}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </ScrollReveal>

        {/* ─── FEATURES ────────────────────────────────────────── */}
        <section className="container py-16 sm:py-20">
          <ScrollReveal direction="up" className="mx-auto max-w-2xl text-center">
            <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
              Why Octora
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Built for traders who don't want to be watched.
            </h2>
          </ScrollReveal>

          <ScrollReveal
            direction="up"
            delay={0.1}
            staggerChildren={0.12}
            className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
          >
            {features.map((f) => (
              <div
                key={f.title}
                className="flex flex-col rounded-2xl border border-border bg-card p-5 motion-safe-lift"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-secondary">
                  <f.icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="mt-4 text-base font-semibold text-foreground">{f.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{f.desc}</p>
              </div>
            ))}
          </ScrollReveal>
        </section>

        {/* ─── HOW IT WORKS ────────────────────────────────────── */}
        <section id="how" className="border-t border-border/70 bg-card/30 py-16 sm:py-20">
          <div className="container">
            <ScrollReveal direction="up" className="mx-auto max-w-2xl text-center">
              <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
                How it works
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                From wallet to pool — without leaving a trace.
              </h2>
            </ScrollReveal>

            <ScrollReveal
              direction="up"
              delay={0.1}
              staggerChildren={0.12}
              className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
            >
              {steps.map((s) => (
                <div
                  key={s.n}
                  className="flex flex-col rounded-2xl border border-border bg-card p-5"
                >
                  <span className="text-xs font-mono text-muted-foreground">{s.n}</span>
                  <h3 className="mt-3 text-base font-semibold text-foreground">{s.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{s.desc}</p>
                </div>
              ))}
            </ScrollReveal>
          </div>
        </section>

        {/* ─── TRENDING POOLS PREVIEW ──────────────────────────── */}
        <section className="container py-16 sm:py-20">
          <ScrollReveal direction="up">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
                  Live pools
                </p>
                <h2 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                  Trending Meteora pools
                </h2>
              </div>
              <Button asChild variant="subtle" size="pill">
                <Link to="/app">
                  Explore all
                  <ArrowRight />
                </Link>
              </Button>
            </div>
          </ScrollReveal>

          <ScrollReveal
            direction="up"
            delay={0.1}
            staggerChildren={0.12}
            className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
          >
            {pools.slice(0, 4).map((p) => (
              <Link
                key={p.id}
                to="/app"
                className="flex flex-col rounded-2xl border border-border bg-card p-5 transition-colors hover:border-primary/30 motion-safe-lift"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-base font-semibold text-foreground">{p.name}</p>
                  <span className="shrink-0 rounded-full border border-border bg-secondary px-2.5 py-1 text-xs text-foreground">
                    {p.apr}
                  </span>
                </div>
                <p className="mt-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  {p.protocol}
                </p>
                <div className="mt-auto grid grid-cols-2 gap-2 pt-4 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">TVL</p>
                    <p className="font-medium text-foreground">{p.tvl}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">24h vol</p>
                    <p className="font-medium text-foreground">{p.volume24h}</p>
                  </div>
                </div>
              </Link>
            ))}
          </ScrollReveal>
        </section>

        {/* ─── ECOSYSTEM LOGO MARQUEE ──────────────────────────── */}
        <ScrollReveal direction="up">
          <LogoMarquee className="border-t border-border/70 bg-card/30 py-16 sm:py-20" />
        </ScrollReveal>

        {/* ─── FAQ ─────────────────────────────────────────────── */}
        <section className="border-t border-border/70 bg-card/30 py-16 sm:py-20">
          <div className="container grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
            <ScrollReveal direction="up">
              <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">FAQ</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Common questions.
              </h2>
              <p className="mt-3 max-w-md text-sm leading-7 text-muted-foreground">
                Octora is non-custodial. You always control your funds — we just shield the
                path between you and the pool.
              </p>
            </ScrollReveal>

            <ScrollReveal
              direction="left"
              delay={0.1}
              staggerChildren={0.06}
              className="space-y-3"
            >
              {faqs.map((f) => (
                <details
                  key={f.q}
                  className="group rounded-xl border border-border bg-card p-5 open:border-primary/30"
                >
                  <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium text-foreground">
                    {f.q}
                    <span className="text-muted-foreground transition-transform group-open:rotate-45">
                      +
                    </span>
                  </summary>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">{f.a}</p>
                </details>
              ))}
            </ScrollReveal>
          </div>
        </section>

        {/* ─── CTA ─────────────────────────────────────────────── */}
        <ScrollReveal direction="up" amount={0.1}>
          <section className="container py-16 sm:py-20">
            <div className="panel-shell relative overflow-hidden rounded-3xl p-8 sm:p-12">
              <div
                className="pointer-events-none absolute inset-0 grid-fade opacity-50"
                aria-hidden="true"
              />
              <div className="relative flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between">
                <div className="max-w-xl space-y-3">
                  <div className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-3 py-1.5 text-xs uppercase tracking-[0.22em] text-muted-foreground">
                    <Lock className="h-3.5 w-3.5 text-primary" />
                    Ready when you are
                  </div>
                  <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                    Stop leaking alpha. Start LPing privately.
                  </h2>
                  <p className="text-sm leading-7 text-muted-foreground">
                    One session. One clean route. Your wallet stays yours.
                  </p>
                </div>
                <Button asChild variant="hero" size="pill">
                  <Link to="/app">
                    Launch app
                    <ArrowRight />
                  </Link>
                </Button>
              </div>
            </div>
          </section>
        </ScrollReveal>
      </main>

      <AppFooter links={footerLinks} />
    </div>
  );
};

export default Index;
