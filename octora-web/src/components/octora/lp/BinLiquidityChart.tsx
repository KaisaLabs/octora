import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DistributionShape, LiquidityBin } from "@/components/octora/types";
import { projectUserShape } from "@/lib/bins";

export interface BinLiquidityChartProps {
  bins: LiquidityBin[];
  activeBinId: number;
  /** When provided, draw the user range overlay. */
  range?: { lower: number; upper: number };
  shape?: DistributionShape;
  depositUsd?: number;
  /** Notified during drag with snapped bin ids. */
  onRangeChange?: (next: { lower: number; upper: number }) => void;
  height?: number;
  /** Display-only mode: no handles, smaller paddings. */
  compact?: boolean;
  /** Overlay pre-computed user liquidity (e.g. existing position). */
  userLiquidity?: number[];
  className?: string;
}

const PAD = { top: 14, right: 12, bottom: 22, left: 12 };
const COMPACT_PAD = { top: 4, right: 4, bottom: 4, left: 4 };

export function BinLiquidityChart({
  bins,
  activeBinId,
  range,
  shape = "spot",
  depositUsd = 0,
  onRangeChange,
  height = 220,
  compact = false,
  userLiquidity,
  className,
}: BinLiquidityChartProps) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(640);
  const [drag, setDrag] = useState<"lower" | "upper" | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const pad = compact ? COMPACT_PAD : PAD;
  const innerW = Math.max(0, width - pad.left - pad.right);
  const innerH = Math.max(0, height - pad.top - pad.bottom);

  const maxLiq = useMemo(() => {
    let m = 0;
    for (const b of bins) if (b.liquidity > m) m = b.liquidity;
    return m || 1;
  }, [bins]);

  const overlay = useMemo<number[]>(() => {
    if (userLiquidity && userLiquidity.length === bins.length) return userLiquidity;
    if (!range) return [];
    return projectUserShape(bins, range.lower, range.upper, shape, depositUsd || 1);
  }, [bins, range, shape, depositUsd, userLiquidity]);

  const overlayMax = useMemo(() => Math.max(1, ...overlay), [overlay]);

  const binWidth = bins.length > 0 ? innerW / bins.length : 0;
  const barWidth = Math.max(1, binWidth - 1);

  const xForBin = useCallback(
    (binId: number) => {
      if (bins.length === 0) return 0;
      const first = bins[0].binId;
      return pad.left + (binId - first + 0.5) * binWidth;
    },
    [bins, binWidth, pad.left],
  );

  const binAtClientX = useCallback(
    (clientX: number) => {
      if (!ref.current || bins.length === 0) return activeBinId;
      const rect = ref.current.getBoundingClientRect();
      const localX = clientX - rect.left - pad.left;
      const idx = Math.round(localX / binWidth - 0.5);
      const clamped = Math.max(0, Math.min(bins.length - 1, idx));
      return bins[clamped].binId;
    },
    [bins, binWidth, pad.left, activeBinId],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!drag || !range || !onRangeChange) return;
      const next = binAtClientX(e.clientX);
      if (drag === "lower") {
        onRangeChange({ lower: Math.min(next, range.upper), upper: range.upper });
      } else {
        onRangeChange({ lower: range.lower, upper: Math.max(next, range.lower) });
      }
    },
    [drag, range, onRangeChange, binAtClientX],
  );

  const stopDrag = useCallback(() => setDrag(null), []);

  useEffect(() => {
    if (!drag) return;
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    return () => {
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
    };
  }, [drag, stopDrag]);

  const activeX = xForBin(activeBinId);

  // Y for a bar with given liquidity (pool background scale).
  const yForLiq = (liq: number) => pad.top + innerH - (liq / maxLiq) * innerH;
  const yForOverlay = (liq: number) => pad.top + innerH - (liq / overlayMax) * innerH * 0.95;

  const lowerX = range ? xForBin(range.lower) - binWidth / 2 : 0;
  const upperX = range ? xForBin(range.upper) + binWidth / 2 : 0;

  return (
    <div className={className} style={{ position: "relative" }}>
      <svg
        ref={ref}
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        onPointerMove={handlePointerMove}
        style={{ touchAction: drag ? "none" : "auto", display: "block" }}
      >
        <defs>
          <linearGradient id="bin-pool-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(155 25% 20%)" stopOpacity="0.85" />
            <stop offset="100%" stopColor="hsl(155 25% 12%)" stopOpacity="0.6" />
          </linearGradient>
          <linearGradient id="bin-user-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(160 84% 55%)" stopOpacity="0.95" />
            <stop offset="100%" stopColor="hsl(160 84% 39%)" stopOpacity="0.7" />
          </linearGradient>
          <linearGradient id="range-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(160 84% 45%)" stopOpacity="0.06" />
            <stop offset="100%" stopColor="hsl(160 84% 45%)" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* Range fill */}
        {range && (
          <rect
            x={Math.max(pad.left, lowerX)}
            y={pad.top}
            width={Math.max(0, Math.min(pad.left + innerW, upperX) - Math.max(pad.left, lowerX))}
            height={innerH}
            fill="url(#range-fill)"
            stroke="hsl(160 84% 39% / 0.18)"
            strokeWidth={1}
          />
        )}

        {/* Pool liquidity bars */}
        {bins.map((b) => {
          const x = xForBin(b.binId) - barWidth / 2;
          const y = yForLiq(b.liquidity);
          const h = pad.top + innerH - y;
          const inRange = !!range && b.binId >= range.lower && b.binId <= range.upper;
          return (
            <rect
              key={`p-${b.binId}`}
              x={x}
              y={y}
              width={barWidth}
              height={Math.max(1, h)}
              fill="url(#bin-pool-grad)"
              opacity={inRange ? 1 : 0.55}
              rx={1}
            />
          );
        })}

        {/* User overlay bars */}
        {overlay.length > 0 &&
          bins.map((b, i) => {
            const liq = overlay[i];
            if (!liq || liq <= 0) return null;
            const x = xForBin(b.binId) - barWidth / 2;
            const y = yForOverlay(liq);
            const h = pad.top + innerH - y;
            return (
              <rect
                key={`u-${b.binId}`}
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(1, h)}
                fill="url(#bin-user-grad)"
                rx={1}
              />
            );
          })}

        {/* Active bin marker */}
        <line
          x1={activeX}
          y1={pad.top - 4}
          x2={activeX}
          y2={pad.top + innerH}
          stroke="hsl(48 96% 60%)"
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
        {!compact && (
          <g>
            <rect
              x={activeX - 22}
              y={pad.top - 12}
              width={44}
              height={14}
              rx={3}
              fill="hsl(48 96% 60%)"
            />
            <text
              x={activeX}
              y={pad.top - 2}
              textAnchor="middle"
              fontSize={9}
              fontWeight={600}
              fontFamily="ui-monospace, SFMono-Regular, monospace"
              letterSpacing={0.4}
              fill="hsl(150 33% 4%)"
            >
              ACTIVE
            </text>
          </g>
        )}

        {/* Range handles */}
        {range && onRangeChange && !compact && (
          <>
            <Handle
              x={lowerX}
              top={pad.top}
              height={innerH}
              label="Min"
              onPointerDown={(e) => {
                (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
                setDrag("lower");
              }}
            />
            <Handle
              x={upperX}
              top={pad.top}
              height={innerH}
              label="Max"
              onPointerDown={(e) => {
                (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
                setDrag("upper");
              }}
            />
          </>
        )}

        {/* X axis price ticks */}
        {!compact && bins.length > 0 && (
          <g>
            {[0, Math.floor(bins.length / 2), bins.length - 1].map((i) => {
              const b = bins[i];
              const x = xForBin(b.binId);
              return (
                <text
                  key={`tick-${i}`}
                  x={x}
                  y={pad.top + innerH + 14}
                  textAnchor="middle"
                  fontSize={10}
                  fontFamily="ui-monospace, SFMono-Regular, monospace"
                  fill="hsl(152 20% 55%)"
                >
                  {formatPrice(b.price)}
                </text>
              );
            })}
          </g>
        )}
      </svg>
    </div>
  );
}

function Handle({
  x,
  top,
  height,
  label,
  onPointerDown,
}: {
  x: number;
  top: number;
  height: number;
  label: string;
  onPointerDown: (e: React.PointerEvent<SVGGElement>) => void;
}) {
  return (
    <g style={{ cursor: "ew-resize" }} onPointerDown={onPointerDown}>
      <rect x={x - 8} y={top - 6} width={16} height={height + 12} fill="transparent" />
      <line x1={x} y1={top - 4} x2={x} y2={top + height + 2} stroke="hsl(160 84% 55%)" strokeWidth={1.5} />
      <rect x={x - 5} y={top - 4} width={10} height={14} rx={2} fill="hsl(160 84% 55%)" />
      <text
        x={x}
        y={top + 6}
        textAnchor="middle"
        fontSize={8}
        fontWeight={700}
        letterSpacing={0.4}
        fill="hsl(150 33% 4%)"
      >
        {label[0]}
      </text>
    </g>
  );
}

function formatPrice(p: number): string {
  if (!Number.isFinite(p)) return "";
  if (p >= 1000) return p.toFixed(0);
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toExponential(2);
}
