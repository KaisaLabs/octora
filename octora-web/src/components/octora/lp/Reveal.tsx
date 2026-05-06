import { useEffect, useState, type ReactNode } from "react";

/**
 * Lightweight staggered reveal. Pairs with tailwindcss-animate's `fade-in`
 * keyframes (defined in tailwind.config.ts). Honors prefers-reduced-motion.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  /** Delay in ms. */
  delay?: number;
  className?: string;
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setReady(true);
      return;
    }
    const id = window.setTimeout(() => setReady(true), 0);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div
      className={className}
      style={{
        animation: ready ? "fade-in 0.5s ease-out both" : "none",
        animationDelay: `${delay}ms`,
        opacity: ready ? undefined : 0,
      }}
    >
      {children}
    </div>
  );
}
