import { Link, Outlet, useLocation } from "react-router-dom";
import { Activity, BriefcaseBusiness, Compass, Loader2, LogOut, Sparkles, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSolana } from "@/providers/SolanaProvider";
import { GlowBackground } from "./GlowBackground";
import { FloatingParticles } from "./FloatingParticles";

function shortenAddress(addr: string): string {
  if (addr.length <= 8) return addr;
  return `${addr.slice(0, 4)}..${addr.slice(-4)}`;
}

const tabs = [
  { to: "/", label: "Pools", icon: Compass },
  { to: "/portfolio", label: "Portfolio", icon: BriefcaseBusiness },
  { to: "/activity", label: "Activity", icon: Activity },
] as const;

export function AppShell() {
  const { pathname } = useLocation();
  const { wallet, connect, disconnect, balance } = useSolana();

  const isActive = (to: string) => {
    if (to === "/") return pathname === "/";
    return pathname.startsWith(to);
  };

  return (
    <div className="relative flex min-h-[100dvh] flex-col overflow-hidden">
      <GlowBackground />
      <FloatingParticles count={30} />

      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/95 backdrop-blur-xl">
        <div className="container flex min-h-14 items-center justify-between gap-3 py-2.5 sm:min-h-16 sm:py-3">
          <Link to="/" className="flex items-center gap-2">
            <span className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
              Octora
            </span>
          </Link>

          {/* Desktop tabs */}
          <nav className="hidden items-center gap-1 sm:flex">
            {tabs.map((tab) => (
              <Link
                key={tab.to}
                to={tab.to}
                className={`rounded-lg px-3.5 py-2 text-sm transition-colors ${
                  isActive(tab.to)
                    ? "bg-surface-elevated text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.label}
              </Link>
            ))}
          </nav>

          {/* Wallet */}
          <div className="flex items-center gap-2">
            {!wallet.connected && !wallet.connecting && (
              <Button
                variant="hero"
                size="sm"
                className="rounded-full"
                onClick={connect}
              >
                <Wallet className="h-4 w-4" />
                <span className="hidden sm:inline">Connect</span>
              </Button>
            )}

            {wallet.connecting && (
              <div className="flex items-center gap-2 rounded-full border border-border bg-secondary/70 px-3 py-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                <span className="text-xs text-muted-foreground">Connecting...</span>
              </div>
            )}

            {wallet.connected && wallet.address && (
              <>
                <div className="hidden items-center gap-2 rounded-full border border-border bg-secondary/70 px-3 py-1.5 sm:flex">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  <div className="leading-tight">
                    <p className="text-xs font-medium text-foreground">
                      {shortenAddress(wallet.address)}
                    </p>
                    {balance !== null && (
                      <p className="text-[10px] text-muted-foreground">
                        {Number(balance) / 1e9} SOL
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 rounded-full border border-border bg-secondary/70 px-2.5 py-1.5 sm:hidden">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  <span className="text-xs font-medium text-foreground">
                    {shortenAddress(wallet.address)}
                  </span>
                </div>

                <Button
                  variant="subtle"
                  size="sm"
                  className="rounded-full"
                  onClick={disconnect}
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="container flex-1 pb-20 pt-6 sm:pb-8 sm:pt-8">
        <Outlet />
      </main>

      {/* Mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur-xl sm:hidden">
        <div className="flex items-center justify-around py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = isActive(tab.to);
            return (
              <Link
                key={tab.to}
                to={tab.to}
                className={`flex flex-col items-center gap-0.5 px-4 py-1 transition-colors ${
                  active ? "text-primary" : "text-muted-foreground"
                }`}
              >
                <Icon className="h-5 w-5" />
                <span className="text-[10px] font-medium">{tab.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
