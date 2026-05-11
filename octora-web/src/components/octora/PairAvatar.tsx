import { useState } from "react";

interface Props {
  a: string;
  b: string;
  /** Optional icon URLs. When missing or the image fails to load, falls back
   *  to a colored circle with the symbol initials. */
  iconA?: string | null;
  iconB?: string | null;
}

/** Two overlapping token avatars used in pool/position list rows. Renders
 *  Jupiter-hosted PNGs when available and falls back to symbol initials so
 *  unverified or freshly-listed tokens still render something. */
export function PairAvatar({ a, b, iconA, iconB }: Props) {
  return (
    <div className="relative h-8 w-12 shrink-0">
      <TokenAvatar
        symbol={a}
        icon={iconA}
        className="absolute left-0 top-0 z-[1] bg-secondary/60"
      />
      <TokenAvatar
        symbol={b}
        icon={iconB}
        className="absolute left-4 top-0 z-[2] bg-secondary"
      />
    </div>
  );
}

function TokenAvatar({
  symbol,
  icon,
  className,
}: {
  symbol: string;
  icon?: string | null;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const showImg = !!icon && !broken;
  return (
    <span
      className={`flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-border text-[10px] font-semibold uppercase text-foreground/80 ${className ?? ""}`}
    >
      {showImg ? (
        <img
          src={icon!}
          alt={symbol}
          loading="lazy"
          onError={() => setBroken(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        initials(symbol)
      )}
    </span>
  );
}

function initials(token: string): string {
  if (!token) return "?";
  return token.slice(0, 2).toUpperCase();
}
