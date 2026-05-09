import type { PriceInfo, PriceMap } from "@/lib/api";

interface Props {
  tokenA: string;
  tokenB: string;
  tokenAMint: string;
  tokenBMint: string;
  prices: PriceMap | undefined;
  /** Compact = one row per token; stacked = two rows. */
  layout?: "stacked" | "inline";
}

/**
 * Renders live USD prices for a token pair from a shared PriceMap (expected
 * to be populated by a single `usePrices` call up the tree, so we don't fan
 * out one query per row).
 */
export function PoolPairPrice({ tokenA, tokenB, tokenAMint, tokenBMint, prices, layout = "stacked" }: Props) {
  const a = prices?.[tokenAMint];
  const b = prices?.[tokenBMint];

  if (layout === "inline") {
    return (
      <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
        <PriceInline symbol={tokenA} info={a} />
        <span className="text-muted-foreground/40">·</span>
        <PriceInline symbol={tokenB} info={b} />
      </span>
    );
  }

  return (
    <div className="space-y-0.5 text-xs">
      <PriceLine symbol={tokenA} info={a} />
      <PriceLine symbol={tokenB} info={b} />
    </div>
  );
}

function PriceLine({ symbol, info }: { symbol: string; info: PriceInfo | undefined }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {symbol}
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="font-mono tabular-nums text-foreground">{fmtUsd(info?.usdPrice)}</span>
        <ChangeBadge pct={info?.priceChange24h} />
      </span>
    </div>
  );
}

function PriceInline({ symbol, info }: { symbol: string; info: PriceInfo | undefined }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {symbol}
      </span>
      <span className="font-mono tabular-nums text-foreground">{fmtUsd(info?.usdPrice)}</span>
      <ChangeBadge pct={info?.priceChange24h} compact />
    </span>
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
    <span className={`inline-flex items-center gap-0.5 text-[10px] tabular-nums ${tone}`}>
      <span aria-hidden>{arrow}</span>
      {value}
    </span>
  );
}

function fmtUsd(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(2)}`;
}
