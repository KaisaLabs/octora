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
                  <path d="M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2z" />
                </svg>
              </a>
              <a
                href="#"
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/10 bg-emerald-500/5 text-emerald-100/40 transition-colors hover:border-emerald-500/25 hover:text-emerald-400"
                aria-label="GitHub"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                </svg>
              </a>
              <a
                href="#"
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/10 bg-emerald-500/5 text-emerald-100/40 transition-colors hover:border-emerald-500/25 hover:text-emerald-400"
                aria-label="Discord"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
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
                <a href="#" className="text-sm text-emerald-100/40 transition-colors hover:text-emerald-400">
                  Documentation
                </a>
              </li>
              <li>
                <a href="#" className="text-sm text-emerald-100/40 transition-colors hover:text-emerald-400">
                  GitHub
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
                <a href="#" className="text-sm text-emerald-100/40 transition-colors hover:text-emerald-400">
                  Discord
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
