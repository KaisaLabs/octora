import { AlertTriangle, Eye, KeyRound, RefreshCw, ShieldOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface StealthExplainerModalProps {
  open: boolean;
  onContinue: () => void;
  onCancel: () => void;
}

/**
 * Pre-deposit explainer for the stealth-wallet UX (P1-38).
 *
 * Octora derives the stealth keypair deterministically from the user's
 * main-wallet `signMessage` (see `lib/stealthVault.ts`). That model has
 * three properties users absolutely must understand before their first
 * deposit:
 *
 *   1. Recovery is the same signMessage on any device. There is no
 *      "stealth seed phrase" — the seed *is* the signature.
 *   2. Losing access to the main wallet permanently strands any rent
 *      and any un-withdrawn dust held by the stealth wallet.
 *   3. Two browsers signing the same derivation message produce the
 *      same stealth keypair, so private windows and shared machines
 *      do not produce a fresh identity.
 *
 * Surfaced once per wallet via `localStorage.octora.stealth-ack`; users
 * can re-open it from the wallet popover via the "How does this work?"
 * affordance.
 */
export function StealthExplainerModal({ open, onContinue, onCancel }: StealthExplainerModalProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onCancel())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            How your stealth wallet works
          </DialogTitle>
          <DialogDescription>
            Read this once before your first private deposit. It is not a tutorial — it is the
            recovery model.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-3 text-sm">
          <li className="flex gap-3 rounded-md border border-border bg-muted/30 p-3">
            <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div>
              <p className="font-medium">Recovery is your wallet signature.</p>
              <p className="text-muted-foreground">
                Your stealth keypair is derived from a free, off-chain signature with your
                connected wallet. Sign the same message on any device and the same stealth
                address comes back — no seed phrase to copy down.
              </p>
            </div>
          </li>

          <li className="flex gap-3 rounded-md border border-border bg-muted/30 p-3">
            <ShieldOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div>
              <p className="font-medium">Lose origin wallet = lose Position funds.</p>
              <p className="text-muted-foreground">
                If you can no longer sign with the origin wallet, you cannot recover the
                stealth wallet either. The SOL in any Position owned by that stealth wallet
                becomes unrecoverable.
              </p>
            </div>
          </li>

          <li className="flex gap-3 rounded-md border border-border bg-muted/30 p-3">
            <Eye className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
            <div>
              <p className="font-medium">Privacy comes from unlinkability.</p>
              <p className="text-muted-foreground">
                Octora cannot escrow or recover your stealth wallet because that would give the
                backend a recovery path and weaken unlinkability. The origin wallet is the only
                recovery key.
              </p>
            </div>
          </li>

          <li className="flex gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div>
              <p className="font-medium">Each position gets its own private address — don't share it.</p>
              <p className="text-muted-foreground">
                Octora derives a fresh stealth address for every position you open, so even two
                deposits into the same pool can't be linked. <span className="font-medium text-amber-200">
                Don't paste these addresses into portfolio explorers</span> like Solscan, Step, or
                Sonar. The lookup is logged on the explorer side and can later be tied back to
                you through their session / IP history — that single search undoes the privacy
                this product gives you.
              </p>
            </div>
          </li>
        </ul>

        <DialogFooter className="mt-2 gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Not now
          </Button>
          <Button variant="hero" onClick={onContinue}>
            I understand — continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
