import type { DistributionShape } from "@/components/octora/types";

const PRESETS: { value: DistributionShape; label: string; sub: string }[] = [
  { value: "spot", label: "Spot", sub: "Uniform" },
  { value: "curve", label: "Curve", sub: "Concentrated" },
  { value: "bid-ask", label: "Bid-Ask", sub: "Edges" },
];

export function DistributionPreset({
  value,
  onChange,
}: {
  value: DistributionShape;
  onChange: (s: DistributionShape) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {PRESETS.map((p) => {
        const active = p.value === value;
        return (
          <button
            key={p.value}
            type="button"
            onClick={() => onChange(p.value)}
            className={`group flex flex-col items-stretch gap-2 rounded-xl border px-3 py-3 text-left transition-colors ${
              active
                ? "border-primary/50 bg-surface-elevated"
                : "border-border bg-card hover:border-primary/25 hover:bg-surface-elevated/40"
            }`}
          >
            <ShapeThumb shape={p.value} active={active} />
            <div>
              <p className={`text-sm font-medium ${active ? "text-foreground" : "text-foreground/85"}`}>
                {p.label}
              </p>
              <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{p.sub}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function ShapeThumb({ shape, active }: { shape: DistributionShape; active: boolean }) {
  const fill = active ? "hsl(160 84% 55%)" : "hsl(155 25% 30%)";
  const opacity = active ? 1 : 0.85;
  const bars = 17;
  const heights = Array.from({ length: bars }, (_, i) => {
    const t = (i - (bars - 1) / 2) / ((bars - 1) / 2);
    if (shape === "spot") return 0.55;
    if (shape === "curve") return Math.max(0.12, Math.exp(-(t * t) * 3));
    return Math.max(0.18, 0.25 + 0.75 * t * t);
  });
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="h-7 w-full">
      {heights.map((h, i) => {
        const w = 100 / bars - 1;
        const x = (100 / bars) * i + 0.5;
        const barH = h * 24;
        return <rect key={i} x={x} y={26 - barH} width={w} height={barH} rx={0.6} fill={fill} opacity={opacity} />;
      })}
    </svg>
  );
}
