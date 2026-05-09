import { useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

import {
  CURRENT_TOS_VERSION,
  TOS_ACK_MESSAGE,
  recordTosAck,
} from "@/lib/tosAck";

interface SignableProvider {
  signMessage?: (
    message: Uint8Array,
    encoding?: "utf8",
  ) => Promise<{ signature: Uint8Array }>;
}

interface InjectedWindow {
  solana?: SignableProvider & { isPhantom?: boolean };
  phantom?: { solana?: SignableProvider };
  solflare?: SignableProvider;
  backpack?: { solana?: SignableProvider };
}

function getSigningProvider(): SignableProvider {
  const w = window as unknown as InjectedWindow;
  const candidates: Array<SignableProvider | undefined> = [
    w.phantom?.solana,
    w.solana,
    w.backpack?.solana,
    w.solflare,
  ];
  const hit = candidates.find((p) => p && typeof p.signMessage === "function");
  if (!hit) throw new Error("Connected wallet does not support signMessage.");
  return hit;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

interface TosAckModalProps {
  open: boolean;
  walletAddress: string | null;
  onAcknowledged: () => void;
  onCancel: () => void;
}

/**
 * First-deposit BETA / UNAUDITED acknowledgement modal (P1-36).
 *
 * Three gates before a wallet can interact with the protocol:
 *   1. Read the scrollable disclosure inside the modal.
 *   2. Tick the explicit "I understand" checkbox.
 *   3. signMessage the version-tagged ack body. The signature pins the
 *      ack to the exact text and version the user saw.
 *
 * On success the ack is persisted in `localStorage` (see lib/tosAck.ts).
 * Backend persistence is wire-here when the API endpoint lands.
 */
export function TosAckModal({ open, walletAddress, onAcknowledged, onCancel }: TosAckModalProps) {
  const [confirmed, setConfirmed] = useState(false);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setConfirmed(false);
    setSigning(false);
    setError(null);
  };

  const handleSign = async () => {
    if (!walletAddress) return;
    setError(null);
    setSigning(true);
    try {
      const provider = getSigningProvider();
      const encoded = new TextEncoder().encode(TOS_ACK_MESSAGE);
      const { signature } = await provider.signMessage!(encoded, "utf8");
      recordTosAck({ walletAddress, signature: bytesToBase64(signature) });
      reset();
      onAcknowledged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet refused the signature.");
      setSigning(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onCancel();
        }
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-500" />
            Beta acknowledgement
            <span className="ml-auto rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-amber-200">
              {CURRENT_TOS_VERSION}
            </span>
          </DialogTitle>
          <DialogDescription>
            Read each line, tick the box, and sign with your wallet. The signature is recorded
            client-side; nothing is sent on-chain.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="h-64 rounded-md border border-border bg-muted/30 p-4 text-xs leading-relaxed">
          <pre className="whitespace-pre-wrap font-mono">{TOS_ACK_MESSAGE}</pre>
        </ScrollArea>

        <label className="mt-2 flex items-start gap-2 rounded-md border border-border p-3 text-sm">
          <Checkbox
            id="tos-confirm"
            checked={confirmed}
            onCheckedChange={(v) => setConfirmed(v === true)}
            disabled={signing}
          />
          <span>
            I have read the disclosure above. I understand the smart contracts are unaudited and
            that I may lose every lamport I deposit.
          </span>
        </label>

        {error && (
          <p className="mt-1 rounded-md border border-red-500/40 bg-red-950/40 p-2 text-xs text-red-200">
            {error}
          </p>
        )}

        <DialogFooter className="mt-4 gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={signing}>
            Cancel
          </Button>
          <Button
            variant="hero"
            onClick={handleSign}
            disabled={!confirmed || signing || !walletAddress}
          >
            {signing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Sign with wallet
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
