import { ShieldCheck, Sparkles, Unplug } from "lucide-react";

import { Button } from "@/components/ui/button";

interface OctoraHeaderProps {
  walletAddress: string;
  sessionStatus: string;
}

export function OctoraHeader({ walletAddress, sessionStatus }: OctoraHeaderProps) {
  return (
    <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur-xl">
      <div className="container flex h-20 items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-primary/30 bg-accent shadow-glow">
            <ShieldCheck className="text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold tracking-tight">Octora</span>
              <span className="rounded-full border border-border/80 bg-secondary px-2.5 py-1 text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
                Private LP
              </span>
            </div>
            <p className="text-sm text-muted-foreground">Privacy-first liquidity routing for Meteora pools</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-3 rounded-full border border-border/80 bg-secondary/70 px-4 py-2 md:flex">
            <Sparkles className="h-4 w-4 text-primary" />
            <div className="text-right">
              <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">{sessionStatus}</p>
              <p className="text-sm font-medium text-foreground">{walletAddress}</p>
            </div>
          </div>
          <Button variant="premium" size="pill">
            <Unplug />
            Disconnect
          </Button>
        </div>
      </div>
    </header>
  );
}
