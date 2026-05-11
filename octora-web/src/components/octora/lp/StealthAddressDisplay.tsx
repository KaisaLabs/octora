import { useState } from "react";
import { AlertTriangle, Check, Copy, ExternalLink } from "lucide-react";

/**
 * Displays a stealth pubkey with an inline warning + tooltip.
 *
 * The warning is the whole point of the component: a stealth address is
 * private TO THE USER. Pasting it into Solscan / Step / Sonar / any
 * portfolio explorer creates a permanent record on that explorer that
 * links the user's main wallet (via the explorer's own session / IP
 * logs) to the position. This undoes the privacy the system gives them.
 *
 * Surfaces in:
 *   - PrivateDepositModal SuccessBody
 *   - PrivateClaimModal SuccessBody
 *   - PrivateExitModal SuccessBody
 *   - PositionDetailPage wherever the stealth pubkey is shown
 */
interface Props {
  /** Base58 stealth pubkey. */
  pubkey: string;
  /** Label above the address. Defaults to "Private address". */
  label?: string;
  /** When false, hides the truncated address — useful for "Sweep" / dust
   *  UIs where the stealth balance matters but the address itself doesn't
   *  need to be re-copied. */
  showAddress?: boolean;
}

export function StealthAddressDisplay({
  pubkey,
  label = "Private address",
  showAddress = true,
}: Props) {
  const [copied, setCopied] = useState(false);

  const truncated =
    pubkey.length > 12 ? `${pubkey.slice(0, 6)}…${pubkey.slice(-4)}` : pubkey;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(pubkey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard write can fail in non-secure contexts; silently no-op
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-card/40 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {label}
        </span>
        {showAddress && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs tabular-nums text-foreground">
              {truncated}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Copy stealth address"
            >
              {copied ? (
                <Check className="h-3 w-3 text-emerald-400" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </div>
        )}
      </div>

      <div className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] leading-4 text-amber-200">
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-300" />
        <span>
          <span className="font-medium text-amber-100">
            Don't paste this into portfolio explorers.
          </span>{" "}
          Solscan, Step, Sonar, and any third-party tracker that lets you
          look up an address will permanently log that lookup. Anyone
          watching their session / IP / referrer history can then link
          this position back to you.{" "}
          <a
            href={`https://solscan.io/account/${encodeURIComponent(pubkey)}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 underline decoration-dotted hover:no-underline"
          >
            On-chain history is public regardless
            <ExternalLink className="h-2.5 w-2.5" />
          </a>{" "}
          — the warning is about who's <em>asking the explorer</em> about it.
        </span>
      </div>
    </div>
  );
}
