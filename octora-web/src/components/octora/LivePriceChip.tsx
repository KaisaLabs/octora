import { useEffect, useRef, useState } from "react";

import { usePrices } from "@/hooks/usePrices";
import type { PriceInfo } from "@/lib/api";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const DISPLAY: Array<{ symbol: string; mint: string }> = [
  { symbol: "SOL", mint: SOL_MINT },
  { symbol: "USDC", mint: USDC_MINT },
];

function fmtUsd(n: number): string {
  if (n >= 1000) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toExponential(2)}`;
}

/**
 * Compact live ticker for SOL/USDC, polling every 5s. Pulses on price change
 * so the realtime is visible. Hidden on small screens to keep the header tidy.
 */
export function LivePriceChip() {
  const { data, isLoading } = usePrices([SOL_MINT, USDC_MINT]);

  return (
    <div className="hidden items-center gap-1.5 rounded-full border border-border bg-secondary/70 px-2.5 py-1 md:inline-flex">
      <span
        title="Live prices via Jupiter v3 — refreshes every 5s"
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_6px_hsl(160_84%_55%)]"
      />
      {DISPLAY.map(({ symbol, mint }) => (
        <PriceCell
          key={mint}
          symbol={symbol}
          info={data?.[mint]}
          loading={isLoading && !data}
        />
      ))}
    </div>
  );
}

function PriceCell({ symbol, info, loading }: { symbol: string; info?: PriceInfo; loading: boolean }) {
  const prevRef = useRef<number | undefined>(undefined);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (info?.usdPrice == null) return;
    const prev = prevRef.current;
    if (prev != null && prev !== info.usdPrice) {
      setFlash(info.usdPrice > prev ? "up" : "down");
      const t = setTimeout(() => setFlash(null), 600);
      return () => clearTimeout(t);
    }
    prevRef.current = info.usdPrice;
  }, [info?.usdPrice]);

  if (loading) {
    return <span className="text-[11px] text-muted-foreground">{symbol}…</span>;
  }
  if (!info) {
    return <span className="text-[11px] text-muted-foreground">{symbol} —</span>;
  }

  const flashClass =
    flash === "up"
      ? "text-primary"
      : flash === "down"
        ? "text-amber-400"
        : "text-foreground";

  return (
    <span className="inline-flex items-baseline gap-1 px-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {symbol}
      </span>
      <span className={`font-mono text-xs tabular-nums transition-colors duration-500 ${flashClass}`}>
        {fmtUsd(info.usdPrice)}
      </span>
    </span>
  );
}
