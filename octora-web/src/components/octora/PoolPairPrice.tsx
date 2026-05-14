import type { PriceMap } from "@/lib/api";

interface Props {
  tokenA: string;
  tokenB: string;
  tokenAMint: string;
  tokenBMint: string;
  prices: PriceMap | undefined;
  /** Pool price in tokenY-per-tokenX (from Meteora's `current_price`).
   *  Preferred over `prices` because it shares a source with the pool
   *  detail page, so the two surfaces never drift. */
  activePrice?: number;
  /** Compact = inline; stacked = price on top, pct below. */
  layout?: "stacked" | "inline";
}

const QUOTE_SYMBOLS = new Set(["SOL", "USDC", "USDT"]);

/**
 * Renders the pool price as `<price> <quote>` plus a 24h-change pct on a
 * second line. Mirrors the pool-detail "Active price" label so discovery
 * and detail read the same number.
 *
 * Price source priority:
 *   1. `activePrice` prop (Meteora `current_price` → matches detail page).
 *   2. Jupiter oracle quotient `tokenA_usd / tokenB_usd` (fallback when
 *      indexer omits the field, e.g. legacy devnet rows).
 *
 * 24h-change pct is always Jupiter's `priceChange24h` for tokenA, since
 * Meteora doesn't expose a pct in the pool summary.
 */
export function PoolPairPrice({ tokenA, tokenB, tokenAMint, tokenBMint, prices, activePrice, layout = "stacked" }: Props) {
  const a = prices?.[tokenAMint];
  const b = prices?.[tokenBMint];

  const quoteSymbol = QUOTE_SYMBOLS.has(tokenB.toUpperCase()) ? tokenB.toUpperCase() : null;

  // Prefer the indexer-supplied pool price for consistency with the detail
  // page; fall back to the oracle ratio when the indexer didn't return one.
  let price: number | null = null;
  if (activePrice && Number.isFinite(activePrice) && activePrice > 0) {
    price = activePrice;
  } else if (quoteSymbol && a?.usdPrice && b?.usdPrice) {
    price = a.usdPrice / b.usdPrice;
  } else if (a?.usdPrice) {
    price = a.usdPrice;
  }

  const display = price != null
    ? quoteSymbol
      ? `${fmtToken(price)} ${quoteSymbol}`
      : fmtUsd(price)
    : "—";
  const pct = a?.priceChange24h;

  if (layout === "inline") {
    return (
      <span className="inline-flex items-baseline gap-2 text-xs">
        <span className="font-mono font-semibold tabular-nums text-foreground">{display}</span>
        <ChangeBadge pct={pct} compact />
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-0.5 leading-tight">
      <span className="font-mono text-sm font-semibold tabular-nums text-foreground">{display}</span>
      <ChangeBadge pct={pct} />
    </div>
  );
}

function ChangeBadge({ pct, compact }: { pct: number | undefined; compact?: boolean }) {
  if (pct == null || !Number.isFinite(pct)) {
    return <span className="text-[10px] text-muted-foreground/50">—</span>;
  }
  const up = pct >= 0;
  const tone = up ? "text-primary" : "text-amber-400";
  const arrow = up ? "▲" : "▼";
  const value = `${Math.abs(pct).toFixed(2)}%`;
  if (compact) {
    return (
      <span className={`text-[10px] tabular-nums ${tone}`}>
        {arrow}
        {value}
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] tabular-nums ${tone}`}>
      <span aria-hidden>{arrow}</span>
      {value}
    </span>
  );
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "—";
  if (n >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(2)}`;
}

function fmtToken(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  const magnitude = Math.floor(Math.log10(n));
  const decimals = Math.max(4, 3 - magnitude);
  return n.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}
