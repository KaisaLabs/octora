import { useEffect, useMemo, useState } from "react";

interface Particle {
  id: number;
  left: number;
  top: number;
  size: number;
  duration: number;
  delay: number;
  drift: number;
}

function generateParticles(count: number): Particle[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    left: Math.random() * 100,
    top: Math.random() * 100,
    size: 1 + Math.random() * 3,
    duration: 12 + Math.random() * 20,
    delay: Math.random() * 15,
    drift: (Math.random() - 0.5) * 40,
  }));
}

export function FloatingParticles({ count = 40 }: { count?: number }) {
  const [mounted, setMounted] = useState(false);
  const particles = useMemo(() => generateParticles(count), [count]);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden mix-blend-screen">
      {particles.map((p) => (
        <div
          key={p.id}
          className="absolute rounded-full bg-emerald-400/40"
          style={{
            left: `${p.left}%`,
            top: `${p.top}%`,
            width: p.size,
            height: p.size,
            boxShadow: `0 0 ${p.size * 2}px rgba(16, 185, 129, 0.5)`,
            animation: `float-up ${p.duration}s linear ${p.delay}s infinite`,
            ["--drift" as string]: `${p.drift}px`,
          }}
        />
      ))}

      <style>{`
        @keyframes float-up {
          0% { transform: translateY(0) translateX(0); opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { transform: translateY(-100vh) translateX(var(--drift, 10px)); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
