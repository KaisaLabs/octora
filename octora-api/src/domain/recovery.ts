import type { ExecutionMode, FailureStage } from "./position-intent";

export type RecoverySafeNextStep = "wait" | "retry" | "refresh" | "contact-support";

export interface RecoveryGuidance {
  headline: string;
  message: string;
  safeNextStep: RecoverySafeNextStep;
  terminal: boolean;
  fallbackMode?: ExecutionMode;
  surfaceDowngradeDisclosure?: boolean;
}

export const recoveryCatalog = {
  signature: {
    headline: "Signature is still needed",
    message: "Octora is waiting for a valid signature. Sign again to continue.",
    safeNextStep: "retry",
    terminal: false,
  },
  "pre-funding": {
    headline: "Position downgraded to standard mode",
    message: "Octora downgraded this Position to standard mode to keep the trade window open. Your origin wallet is now linked to this Position.",
    safeNextStep: "wait",
    terminal: true,
    fallbackMode: "standard",
    surfaceDowngradeDisclosure: true,
  },
  "funding-partial": {
    headline: "Position downgraded to standard mode",
    message: "Octora downgraded this Position to standard mode to keep the trade window open. Your origin wallet is now linked to this Position.",
    safeNextStep: "wait",
    terminal: true,
    fallbackMode: "standard",
    surfaceDowngradeDisclosure: true,
  },
  "venue-submission": {
    headline: "Meteora rejected the submission",
    message: "The pool did not accept the request. Review the setup, then retry.",
    safeNextStep: "retry",
    terminal: true,
  },
  "venue-confirmation": {
    headline: "Confirmation is still pending",
    message: "The onchain submission has not finished confirming yet. Octora is waiting safely.",
    safeNextStep: "wait",
    terminal: false,
  },
  "indexing-lag": {
    headline: "Still waiting on the final snapshot",
    message: "The venue finished, but the final snapshot has not landed yet. Refresh this view in a moment.",
    safeNextStep: "refresh",
    terminal: false,
  },
  "recovery-required": {
    headline: "Needs attention",
    message: "Octora stopped the flow safely. Review the position and try again.",
    safeNextStep: "contact-support",
    terminal: true,
  },
  // ── Private Position Close failure stages (close/01) ──────────────
  // No `fallbackMode` on any of these — the close flow has no
  // standard-mode escape lane. `safeNextStep: contact-support` is the
  // honest answer until close/03 lands the user-signed close-recovery
  // action button on top.
  "close-submission": {
    headline: "Closing the position failed",
    message:
      "The DLMM close transaction did not land. Funds are still inside the DLMM Position on Meteora — nothing has moved. Recovery is being prepared.",
    safeNextStep: "contact-support",
    terminal: true,
  },
  "swap-submission": {
    headline: "Swapping to SOL failed",
    message:
      "The DLMM Position closed but the residual non-SOL token did not swap. Funds sit at the Stealth Wallet. Recovery is being prepared.",
    safeNextStep: "contact-support",
    terminal: true,
  },
  "remix-submission": {
    headline: "Re-mixing into the anonymity set failed",
    message:
      "The Stealth Wallet holds the close proceeds in SOL, but the mixer deposit did not land. Recovery is being prepared.",
    safeNextStep: "contact-support",
    terminal: true,
  },
} as const satisfies Record<FailureStage, RecoveryGuidance>;

export function getRecoveryGuidance(failureStage: FailureStage | null | undefined): RecoveryGuidance | null {
  if (!failureStage) {
    return null;
  }

  return recoveryCatalog[failureStage];
}
