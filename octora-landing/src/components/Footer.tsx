export function Footer() {
  return (
    <footer className="relative z-10 border-t border-emerald-500/10 px-6 pt-16 pb-8">
      <div className="mx-auto max-w-6xl">
        {/* Top row */}
        <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
          {/* Brand */}
          <div className="lg:col-span-1">
            <div className="flex items-baseline gap-1">
              <span className="text-xl font-bold tracking-tight text-white">
                Octora
              </span>
              <span className="text-xs font-medium text-emerald-400/60">
                .xyz
              </span>
            </div>
            <p className="mt-3 max-w-xs text-sm leading-6 text-emerald-100/40">
              Privacy Layer for LP trade on Meteora.
              <br />
              Let your main wallet stay invisible.
            </p>

            {/* Social icons */}
            <div className="mt-5 flex items-center gap-3">
              <a
                href="https://x.com/octora_xyz"
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/10 bg-emerald-500/5 text-emerald-100/40 transition-colors hover:border-emerald-500/25 hover:text-emerald-400"
                aria-label="X / Twitter"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </a>
            </div>
          </div>

          {/* Product links */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-100/60">
              Product
            </h4>
            <ul className="mt-4 space-y-3">
              <li>
                <a href="#how" className="text-sm text-emerald-100/40 transition-colors hover:text-emerald-400">
                  How it Works
                </a>
              </li>
              <li>
                <a href="#demo" className="text-sm text-emerald-100/40 transition-colors hover:text-emerald-400">
                  Demo
                </a>
              </li>
              <li>
                <a href="#faq" className="text-sm text-emerald-100/40 transition-colors hover:text-emerald-400">
                  FAQ
                </a>
              </li>
            </ul>
          </div>

          {/* Resources links */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-100/60">
              Resources
            </h4>
            <ul className="mt-4 space-y-3">
              <li>
                <a href="/docs" className="text-sm text-emerald-100/40 transition-colors hover:text-emerald-400">
                  Documentation
                </a>
              </li>
              <li>
                <a href="/whitepaper" className="text-sm text-emerald-100/40 transition-colors hover:text-emerald-400">
                  Whitepaper
                </a>
              </li>
              <li>
                <a
                  href="https://meteora.ag"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-emerald-100/40 transition-colors hover:text-emerald-400"
                >
                  Meteora
                </a>
              </li>
            </ul>
          </div>

          {/* Community links */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-100/60">
              Community
            </h4>
            <ul className="mt-4 space-y-3">
              <li>
                <a
                  href="https://x.com/octora_xyz"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-emerald-100/40 transition-colors hover:text-emerald-400"
                >
                  Twitter / X
                </a>
              </li>
              <li>
                <a href="#waitlist" className="text-sm text-emerald-100/40 transition-colors hover:text-emerald-400">
                  Join Waitlist
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Divider */}
        <div className="mt-12 border-t border-emerald-500/8" />

        {/* Bottom row */}
        <div className="mt-6 flex flex-col items-center justify-between gap-4 sm:flex-row">
          <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-100/25">
            Meteora &bull; Solana &bull; Octora
          </p>
          <p className="text-[11px] text-emerald-100/20">
            &copy; {new Date().getFullYear()} Octora. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
