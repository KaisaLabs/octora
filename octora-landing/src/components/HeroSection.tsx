import { Sparkles } from "lucide-react";
import { ScrollReveal } from "./ScrollReveal";

export function HeroSection() {
  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <ScrollReveal className="flex flex-col items-center">
        {/* Badge */}
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/5 px-4 py-1.5 backdrop-blur-sm">
          <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
          <span className="text-xs font-medium tracking-[0.16em] text-emerald-400">
            PRIVACY LAYER FOR METEORA
          </span>
        </div>

        {/* Title */}
        <h1 className="text-6xl font-bold tracking-tight sm:text-8xl md:text-9xl">
          <span className="bg-gradient-to-b from-white to-emerald-200/50 bg-clip-text text-transparent drop-shadow-[0_0_30px_rgba(16,185,129,0.2)]">
            Octora
          </span>
        </h1>

        {/* Subtitle */}
        <p className="mt-6 max-w-md text-lg font-light leading-relaxed text-emerald-100/70">
          Privacy Layer for LP trade on{" "}
          <span className="font-medium text-emerald-400">Meteora</span>.
          <br />
          Let your main wallet stay invisible.
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
              <path d="M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2z" />
            </svg>
          </a>
        </div>
      </ScrollReveal>
    </section>
  );
}
