import { motion, useReducedMotion } from "framer-motion";

/* ─────────────────────────────────────────────────────────
 * ScrollReveal — reusable scroll-triggered reveal wrapper.
 *
 * Wraps content with motion.div + whileInView.
 *
 * In stagger mode, each child is wrapped in its own
 * motion.div. Since these sit directly inside the grid
 * container, CSS grid/flex places them correctly.
 *
 * Directions: up | down | left | right | none
 * ───────────────────────────────────────────────────────── */

type ScrollDirection = "up" | "down" | "left" | "right" | "none";

interface ScrollRevealProps {
  children: React.ReactNode;
  direction?: ScrollDirection;
  delay?: number;
  once?: boolean;
  amount?: number;
  staggerChildren?: number;
  className?: string;
}

const DIRECTION_OFFSETS = {
  up: { y: 24 },
  down: { y: -24 },
  left: { x: -24 },
  right: { x: 24 },
  none: {},
} as const;

const SPRING = {
  type: "spring" as const,
  stiffness: 280,
  damping: 26,
  mass: 0.8,
};

export function ScrollReveal({
  children,
  direction = "up",
  delay = 0,
  once = true,
  amount = 0.15,
  staggerChildren,
  className,
}: ScrollRevealProps) {
  const prefersReducedMotion = useReducedMotion();
  const offsets = DIRECTION_OFFSETS[direction];

  if (prefersReducedMotion) {
    return <div className={className}>{children}</div>;
  }

  if (staggerChildren !== undefined && Array.isArray(children)) {
    return (
      <div className={className}>
        {children.map((child, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, ...offsets }}
            whileInView={{ opacity: 1, x: 0, y: 0 }}
            viewport={{ once, amount }}
            transition={{ ...SPRING, delay: delay + i * staggerChildren }}
          >
            {child}
          </motion.div>
        ))}
      </div>
    );
  }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, ...offsets }}
      whileInView={{ opacity: 1, x: 0, y: 0 }}
      viewport={{ once, amount }}
      transition={{ ...SPRING, delay }}
    >
      {children}
    </motion.div>
  );
}
