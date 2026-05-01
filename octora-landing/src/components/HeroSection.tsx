import { ScrollReveal } from "./ScrollReveal";

export function HeroSection() {
  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <ScrollReveal className="flex flex-col items-center">
        {/* Badge */}
        <div className="mb-8 inline-flex items-center gap-2.5 rounded-full border border-emerald-500/20 bg-emerald-500/5 px-5 py-2 backdrop-blur-sm">
          <span className="text-xs font-medium tracking-[0.16em] text-emerald-400">
            ✦ PRIVACY LAYER FOR METEORA
          </span>
        </div>

        {/* Title */}
        <h1 className="text-5xl font-bold tracking-tight sm:text-6xl md:text-7xl">
          <span className="text-white">
            Add liquidity to Meteora
          </span>
          <br />
          <span className="bg-gradient-to-r from-emerald-400 to-emerald-300 bg-clip-text text-transparent">
            privately.
          </span>
        </h1>

        {/* Subtitle */}
        <p className="mt-6 max-w-xl text-base font-light leading-relaxed text-emerald-100/50">
          Octora hides your origin wallet so copy-trade bots can&apos;t track your
          moves. Search, deposit, claim, and withdraw from one clean interface.
        </p>

        {/* CTAs */}
        <div className="mt-10 flex flex-wrap justify-center gap-4">
          <a
            href="#waitlist"
            className="rounded-full bg-emerald-500 px-8 py-3 text-sm font-semibold text-base transition-all hover:bg-emerald-400 hover:shadow-[0_0_24px_rgba(16,185,129,0.4)]"
          >
            Join Waitlist
          </a>
          <a
            href="#how"
            className="rounded-full border border-emerald-500/20 px-8 py-3 text-sm font-medium text-emerald-100/60 transition-colors hover:border-emerald-500/40 hover:text-emerald-100"
          >
            Learn More
          </a>
        </div>

        {/* Social */}
        <div className="mt-12">
          <a
            href="https://x.com/octora_xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm font-medium tracking-wide text-emerald-100/40 transition-colors hover:text-emerald-400"
          >
            <span>Stay updated &rarr; Follow us on X @octora_xyz</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-4 w-4"
            >
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
        </div>
      </ScrollReveal>
    </section>
  );
}
