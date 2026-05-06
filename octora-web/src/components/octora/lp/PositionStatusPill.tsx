interface Props {
  inRange?: boolean;
  label?: string;
  size?: "sm" | "md";
}

export function PositionStatusPill({ inRange, label, size = "md" }: Props) {
  const text = label ?? (inRange ? "In range" : "Out of range");
  const tone = inRange
    ? "border-primary/40 bg-primary/10 text-primary"
    : "border-amber-500/40 bg-amber-500/10 text-amber-400";
  const sz = size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border ${tone} ${sz}`}>
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          inRange ? "bg-primary shadow-[0_0_6px_hsl(160_84%_55%)]" : "bg-amber-400"
        }`}
      />
      {text}
    </span>
  );
}
