import { ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { WalletProviderId, WalletProviderInfo } from "@/providers/SolanaProvider";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: WalletProviderInfo[];
  connecting: boolean;
  /** Currently in-flight provider, if any — for spinner placement. */
  pendingId: WalletProviderId | null;
  onSelect: (id: WalletProviderId) => void;
}

const ICON: Record<WalletProviderId, string> = {
  phantom: "👻",
  solflare: "🔆",
  backpack: "🎒",
};

export function WalletConnectDialog({ open, onOpenChange, providers, connecting, pendingId, onSelect }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl tracking-tight">Connect a wallet</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Pick a wallet. Octora keeps your origin address private during deposits.
          </DialogDescription>
        </DialogHeader>

        <ul className="mt-2 space-y-2">
          {providers.map((p) => {
            const pending = connecting && pendingId === p.id;
            const installed = p.installed;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={connecting}
                  onClick={() => {
                    if (installed) onSelect(p.id);
                    else window.open(p.installUrl, "_blank", "noopener,noreferrer");
                  }}
                  className={`group flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors ${
                    pending
                      ? "border-primary/50 bg-primary/10"
                      : installed
                      ? "border-border bg-background/40 hover:border-primary/30 hover:bg-surface-elevated/40"
                      : "border-border bg-background/40 hover:border-amber-500/30"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-secondary/60 text-xl leading-none">
                    {ICON[p.id]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-foreground">{p.name}</p>
                      {installed ? (
                        <span className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.18em] text-primary">
                          Detected
                        </span>
                      ) : (
                        <span className="rounded-full border border-border bg-secondary/60 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                          Not installed
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {installed ? "Open the extension to approve." : "Install to continue."}
                    </p>
                  </div>
                  {pending ? (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  ) : installed ? null : (
                    <ExternalLink className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        <p className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" />
          Your wallet only signs locally. Octora never sees your seed phrase.
        </p>
      </DialogContent>
    </Dialog>
  );
}
