import { AlertTriangle } from "lucide-react";
import { ACTIVE_CLUSTER } from "@/lib/solana/config";
import { useNetworkStatus } from "@/lib/networkStatus";

/**
 * Persistent top banner — BETA / UNAUDITED disclosure (P1-36) layered
 * with the network-mismatch status (P1-35).
 *
 * Three priority states, in order:
 *   1. mismatch / rpc-error  → red, "Network unsafe — actions blocked"
 *   2. non-mainnet build     → amber, identifies the cluster
 *   3. mainnet build         → amber, BETA / UNAUDITED reminder
 *
 * The component is sticky and lives above every page so the warning is
 * impossible to scroll past without seeing it once.
 */
export function BetaWarningBanner() {
  const status = useNetworkStatus();

  if (status.state === "mismatch") {
    return (
      <Bar tone="danger">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">Network mismatch</span>
        <span className="opacity-90">
          App is configured for <code className="font-mono">{ACTIVE_CLUSTER}</code> but the RPC is
          serving a different chain. Mutating actions are disabled until this is resolved.
        </span>
      </Bar>
    );
  }

  if (status.state === "rpc-error") {
    return (
      <Bar tone="danger">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">RPC unreachable</span>
        <span className="opacity-90">
          Cannot verify the network. Mutating actions are disabled — check your connection or
          try again in a moment.
        </span>
      </Bar>
    );
  }

  if (ACTIVE_CLUSTER !== "mainnet") {
    return (
      <Bar tone="info">
        <span className="font-medium uppercase tracking-wider">{ACTIVE_CLUSTER}</span>
        <span className="opacity-90">
          You are on a non-production network. Funds here are not real value.
        </span>
      </Bar>
    );
  }

  return (
    <Bar tone="warning">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className="font-semibold uppercase tracking-wider">Beta · Unaudited</span>
      <span className="opacity-95">
        Do not deposit funds you can&apos;t afford to lose. Smart contracts have not yet been
        externally audited.
      </span>
    </Bar>
  );
}

interface BarProps {
  tone: "danger" | "warning" | "info";
  children: React.ReactNode;
}

function Bar({ tone, children }: BarProps) {
  const palette = {
    danger:
      "bg-red-950/95 text-red-100 border-b border-red-700/60",
    warning:
      "bg-amber-950/90 text-amber-100 border-b border-amber-600/40",
    info:
      "bg-sky-950/90 text-sky-100 border-b border-sky-700/40",
  }[tone];

  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`relative z-40 w-full ${palette} backdrop-blur`}
    >
      <div className="container flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-[11px] sm:text-xs">
        {children}
      </div>
    </div>
  );
}
