import { LockKeyhole, Shield, Wallet } from "lucide-react";

interface PrivateSessionCardProps {
  walletAddress: string;
  sessionId: string;
  status: string;
  balance: number;
  protectedValue: string;
  privacyRoute: string[];
}

export function PrivateSessionCard({
  walletAddress,
  sessionId,
  status,
  balance,
  protectedValue,
  privacyRoute,
}: PrivateSessionCardProps) {
  return (
    <section className="panel-shell rounded-xl p-6 animate-fade-in [animation-delay:180ms]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.26em] text-muted-foreground">Wallet session</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-full border border-border/80 bg-secondary/70 px-3 py-1.5">
              <Wallet className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium text-foreground">{walletAddress}</span>
            </div>
            <div className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary">
              {status}
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-border/70 bg-secondary/45 px-4 py-3 text-right">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Session ID</p>
          <p className="mt-1 text-sm font-medium text-foreground">{sessionId}</p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-border/70 bg-secondary/45 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Available balance</p>
          <p className="mt-2 text-2xl font-semibold text-foreground">{balance.toFixed(2)} SOL</p>
          <p className="mt-1 text-sm text-muted-foreground">Protected value {protectedValue}</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-secondary/45 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Privacy route</p>
          <ul className="mt-3 space-y-3 text-sm text-foreground">
            {privacyRoute.map((step) => (
              <li key={step} className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full border border-primary/20 bg-primary/10">
                  {step.includes("Origin") ? <Shield className="h-4 w-4 text-primary" /> : <LockKeyhole className="h-4 w-4 text-primary" />}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
