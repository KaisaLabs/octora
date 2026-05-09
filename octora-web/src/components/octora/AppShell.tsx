import { useEffect, useMemo, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { BriefcaseBusiness, Coins, Compass, Loader2, LogOut, Sparkles, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSolana, type WalletProviderId } from "@/providers/SolanaProvider";
import { usePortfolioPositions } from "@/hooks/usePortfolioPositions";
import { hasAckedTos } from "@/lib/tosAck";
import { WalletConnectDialog } from "./lp/WalletConnectDialog";
import { TosAckModal } from "./lp/TosAckModal";
import { BetaWarningBanner } from "./BetaWarningBanner";
import { GlowBackground } from "./GlowBackground";
import { FloatingParticles } from "./FloatingParticles";
import { LivePriceChip } from "./LivePriceChip";

const parseUsd = (v: string | undefined): number => {
  if (!v) return 0;
  const n = parseFloat(v.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

function fmtUsdCompact(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function shortenAddress(addr: string): string {
  if (addr.length <= 8) return addr;
  return `${addr.slice(0, 4)}..${addr.slice(-4)}`;
}

const tabs = [
  { to: "/", label: "Pools", icon: Compass },
  { to: "/portfolio", label: "Portfolio", icon: BriefcaseBusiness },
] as const;

export function AppShell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { wallet, connect, disconnect, balance, providers } = useSolana();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingId, setPendingId] = useState<WalletProviderId | null>(null);
  const [tosOpen, setTosOpen] = useState(false);

  // Open the BETA / UNAUDITED ack modal once per (wallet × disclosure
  // version). Bumping CURRENT_TOS_VERSION in lib/tosAck.ts forces every
  // wallet to re-ack — the audit (P1-36) treats acceptance as
  // version-scoped, not "did this user ever accept any version".
  useEffect(() => {
    if (!wallet.connected || !wallet.address) {
      setTosOpen(false);
      return;
    }
    setTosOpen(!hasAckedTos(wallet.address));
  }, [wallet.connected, wallet.address]);

  // Live claimable across all wallet-owned positions. Pools list is unused
  // here (we only need feeUsd from on-chain state); shared react-query cache
  // dedupes the actual fetch with the portfolio page's call.
  const positions = usePortfolioPositions(wallet.address, []);
  const claimable = useMemo(
    () => positions.reduce((s, p) => s + parseUsd(p.claimable), 0),
    [positions],
  );

  const handlePick = async (id: WalletProviderId) => {
    setPendingId(id);
    try {
      await connect(id);
      setPickerOpen(false);
    } finally {
      setPendingId(null);
    }
  };

  const isActive = (to: string) => {
    if (to === "/") return pathname === "/";
    return pathname.startsWith(to);
  };

  return (
    <div className="relative flex min-h-[100dvh] flex-col overflow-x-hidden">
      <GlowBackground />
      <FloatingParticles count={30} />

      {/* BETA / UNAUDITED + network-mismatch banner. Sticky above the
          header so the warning can never be scrolled past. */}
      <BetaWarningBanner />

      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/95 backdrop-blur-xl">
        <div className="container flex min-h-14 items-center justify-between gap-3 py-2.5 sm:min-h-16 sm:py-3">
          <div className="flex items-center gap-6">
            <Link to="/" className="flex items-center gap-2">
              <span className="font-display text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                Octora
              </span>
            </Link>

            {/* Desktop tabs — grouped with the logo on the left */}
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
          </div>

          {/* Wallet */}
          <div className="flex items-center gap-2">
            <LivePriceChip />

            {wallet.connected && claimable > 0 && (
              <button
                type="button"
                onClick={() => navigate("/portfolio")}
                title={`${fmtUsdCompact(claimable)} claimable across positions`}
                className="hidden items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15 sm:inline-flex"
              >
                <span aria-hidden className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                </span>
                <Coins className="h-3.5 w-3.5" />
                <span className="font-mono tabular-nums">{fmtUsdCompact(claimable)}</span>
                <span className="text-primary/70">claimable</span>
              </button>
            )}
            {!wallet.connected && !wallet.connecting && (
              <Button
                variant="hero"
                size="sm"
                className="rounded-full"
                onClick={() => setPickerOpen(true)}
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

      <WalletConnectDialog
        open={pickerOpen}
        onOpenChange={(o) => {
          if (!wallet.connecting) setPickerOpen(o);
        }}
        providers={providers}
        connecting={wallet.connecting}
        pendingId={pendingId}
        onSelect={handlePick}
      />

      <TosAckModal
        open={tosOpen}
        walletAddress={wallet.address ?? null}
        onAcknowledged={() => setTosOpen(false)}
        onCancel={() => {
          // User dismissed without signing — disconnect rather than leave
          // them in an un-acked state where every action would prompt again.
          setTosOpen(false);
          disconnect();
        }}
      />
    </div>
  );
}
