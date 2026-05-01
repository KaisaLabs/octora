import { useState, useEffect } from "react";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 z-50 w-full transition-all duration-300 ${
        scrolled
          ? "border-b border-white/5 bg-base/80 backdrop-blur-xl"
          : "bg-transparent"
      }`}
    >
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        {/* Logo */}
        <a href="#" className="flex items-center gap-2">
          <span className="text-lg font-bold tracking-tight text-white">
            Octora
          </span>
        </a>

        {/* Nav Links */}
        <ul className="hidden items-center gap-8 md:flex">
          <li>
            <a
              href="#how"
              className="text-sm text-emerald-100/50 transition-colors hover:text-white"
            >
              How it Works
            </a>
          </li>
          <li>
            <a
              href="#why"
              className="text-sm text-emerald-100/50 transition-colors hover:text-white"
            >
              Why Octora
            </a>
          </li>
          <li>
            <a
              href="#faq"
              className="text-sm text-emerald-100/50 transition-colors hover:text-white"
            >
              FAQ
            </a>
          </li>
        </ul>

        {/* CTA */}
        <a
          href="#waitlist"
          className="rounded-full bg-emerald-500 px-5 py-2 text-sm font-semibold text-base transition-all hover:bg-emerald-400 hover:shadow-[0_0_24px_rgba(16,185,129,0.4)]"
        >
          Join Waitlist
        </a>
      </nav>
    </header>
  );
}
