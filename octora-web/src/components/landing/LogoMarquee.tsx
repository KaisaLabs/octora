import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import {
  Bitcoin,
  ChartNoAxesCombined,
  CircleDollarSign,
  Coins,
  Globe,
  Layers,
  Network,
  Shield,
  Wallet,
  Zap,
} from "lucide-react";

/* ─────────────────────────────────────────────────────────
 * LogoMarquee — seamless infinite horizontal logo scroll
 *
 * Two rows of logos scrolling in opposite directions using
 * GSAP. Each row duplicates the set 2× so that as one copy
 * scrolls out of view, the next copy seamlessly appears.
 *
 * Row 1 scrolls right-to-left (←)
 * Row 2 scrolls left-to-right (→)
 * ───────────────────────────────────────────────────────── */

const TOP_ROW_ICONS = [
  { Icon: Bitcoin, label: "Bitcoin" },
  { Icon: Globe, label: "Solana" },
  { Icon: Coins, label: "Ethereum" },
  { Icon: Network, label: "Polygon" },
  { Icon: Layers, label: "Arbitrum" },
  { Icon: Zap, label: "Avalanche" },
  { Icon: CircleDollarSign, label: "Base" },
  { Icon: ChartNoAxesCombined, label: "Optimism" },
];

const BOTTOM_ROW_ICONS = [
  { Icon: Shield, label: "Vanish" },
  { Icon: Wallet, label: "Phantom" },
  { Icon: Network, label: "MagicBlock" },
  { Icon: Globe, label: "Meteora" },
  { Icon: Coins, label: "Jupiter" },
  { Icon: Layers, label: "Orca" },
  { Icon: Zap, label: "Raydium" },
  { Icon: CircleDollarSign, label: "Helius" },
];

interface LogoMarqueeProps {
  className?: string;
}

function IconTile({ Icon, label }: { Icon: React.ElementType; label: string }) {
  return (
    <div className="flex shrink-0 items-center gap-3 rounded-xl border border-border/60 bg-card/60 px-5 py-3.5 backdrop-blur-sm">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border/40 bg-secondary/60">
        <Icon className="h-4.5 w-4.5 text-primary/80" />
      </div>
      <span className="text-sm font-medium text-foreground/80">{label}</span>
    </div>
  );
}

/**
 * Seamless infinite marquee row.
 * Duplicates items 2×, then animates translateX by one full set width
 * and wraps back to 0 — imperceptible because 0 and setWidth are identical.
 */
function MarqueeRow({
  items,
  direction,
}: {
  items: { Icon: React.ElementType; label: string }[];
  direction: "left" | "right";
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const setWidthRef = useRef(0);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) return;

    // Measure one full set width (2 copies → half the total)
    const measure = () => {
      setWidthRef.current = track.scrollWidth / 2;
    };
    measure();

    // Right-to-left (←): start at 0, go to -setWidth, loop
    // Left-to-right (→): start at -setWidth, go to 0, loop
    const fromX = direction === "left" ? 0 : -setWidthRef.current;
    const toX = direction === "left" ? -setWidthRef.current : 0;

    const tween = gsap.fromTo(
      track,
      { x: fromX },
      {
        x: toX,
        duration: 25,
        ease: "none",
        repeat: -1,
        onRepeat() {
          // Snap back to the opposite end — visually identical position
          gsap.set(track, { x: fromX });
        },
      },
    );

    const onResize = () => {
      measure();
      tween.kill();
      // Recreate on resize for simplicity
      const newFrom = direction === "left" ? 0 : -setWidthRef.current;
      const newTo = direction === "left" ? -setWidthRef.current : 0;
      gsap.set(track, { x: newFrom });
    };
    window.addEventListener("resize", onResize);

    return () => {
      tween.kill();
      window.removeEventListener("resize", onResize);
    };
  }, [direction]);

  // Duplicate 2× for seamless loop
  const duplicated = [...items, ...items];

  return (
    <div className="overflow-hidden">
      <div ref={trackRef} className="flex w-max gap-4" aria-hidden="true">
        {duplicated.map((item, i) => (
          <IconTile key={`${item.label}-${i}`} Icon={item.Icon} label={item.label} />
        ))}
      </div>
    </div>
  );
}

export function LogoMarquee({ className }: LogoMarqueeProps) {
  return (
    <section className={className}>
      <div className="container">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
            Ecosystem
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Built on the protocols you trust.
          </h2>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            Octora integrates with Solana's best protocols to keep your liquidity
            private at every layer.
          </p>
        </div>

        <div className="mt-10 space-y-5">
          <MarqueeRow items={TOP_ROW_ICONS} direction="left" />
          <MarqueeRow items={BOTTOM_ROW_ICONS} direction="right" />
        </div>
      </div>
    </section>
  );
}
