import { Link, useLocation } from "react-router-dom";
import { Loader2, LogOut, Sparkles, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSolana } from "@/providers/SolanaProvider";

/* ─────────────────────────────────────────────────────────
 * AppHeader — sticky header with live wallet connection
 *
 * Uses SolanaProvider context for wallet state.
 * Shows:
 *   - Connect button when disconnected
 *   - Address pill + disconnect when connected
 *   - Loading spinner while connecting
 * ───────────────────────────────────────────────────────── */

function shortenAddress(addr: string): string {
  if (addr.length <= 8) return addr;
  return `${addr.slice(0, 4)}..${addr.slice(-4)}`;
}

export function AppHeader() {
  const { pathname } = useLocation();
  const onApp = pathname.startsWith("/app");
  const { wallet, connect, disconnect, balance } = useSolana();

  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-background/95 backdrop-blur-xl">
      <div className="container flex min-h-16 flex-wrap items-center justify-between gap-3 py-3 sm:min-h-20 sm:py-4">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
              Octora
            </span>
          </div>
        </Link>

        <div className="flex items-center gap-2 sm:gap-3">
          {/* Wallet area */}
          {!wallet.connected && !wallet.connecting && (
            <Button
              variant="hero"
              size="sm"
              className="rounded-full"
              onClick={connect}
            >
              <Wallet className="h-4 w-4" />
              <span>Connect Wallet</span>
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
              {/* Desktop wallet pill */}
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

              {/* Mobile compact pill */}
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
                <span className="hidden sm:inline">Disconnect</span>
              </Button>
            </>
          )}

          {/* Open app button (landing page only) */}
          {!onApp && (
            <Button asChild variant="hero" size="sm" className="rounded-full">
              <Link to="/app">Open app</Link>
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
