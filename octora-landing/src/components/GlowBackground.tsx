export function GlowBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      {/* Top gradient wash */}
      <div className="absolute inset-0 bg-gradient-to-b from-emerald-900/30 via-base to-base" />

      {/* Primary glow blob */}
      <div
        className="absolute -top-20 left-1/4 h-[800px] w-[400px] bg-emerald-500/10 blur-[120px]"
        style={{ transform: "rotate(-8deg)" }}
      />

      {/* Secondary glow blob */}
      <div
        className="absolute -top-40 left-1/2 h-[600px] w-[300px] bg-emerald-400/5 blur-[100px]"
        style={{ transform: "rotate(7deg)" }}
      />

      {/* Radial vignette */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,transparent_0%,rgba(1,5,4,0.4)_100%)]" />

      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 h-32 w-full bg-gradient-to-t from-emerald-950/20 to-transparent" />
    </div>
  );
}
