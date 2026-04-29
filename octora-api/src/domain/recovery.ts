import type { ExecutionMode, FailureStage } from "./position-intent";

export type RecoverySafeNextStep = "wait" | "retry" | "refresh" | "contact-support";

export interface RecoveryGuidance {
  headline: string;
  message: string;
  safeNextStep: RecoverySafeNextStep;
  terminal: boolean;
  fallbackMode?: ExecutionMode;
  downgradeRequiresDisclosure?: boolean;
}

export const recoveryCatalog = {
  signature: {
    headline: "Signature is still needed",
    message: "Octora is waiting for a valid signature. Sign again to continue.",
    safeNextStep: "retry",
    terminal: false,
  },
  "pre-funding": {
    headline: "Funding could not start",
    message: "Octora stopped before any funds moved. Check the balance, then retry from the beginning.",
    safeNextStep: "retry",
    terminal: true,
    fallbackMode: "standard",
    downgradeRequiresDisclosure: true,
  },
  "funding-partial": {
    headline: "Funding started, but did not finish cleanly",
    message: "Octora moved into funding, but the flow did not complete. Check the wallet activity, then retry once the balance is ready.",
    safeNextStep: "contact-support",
    terminal: true,
    fallbackMode: "standard",
    downgradeRequiresDisclosure: true,
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
} as const satisfies Record<FailureStage, RecoveryGuidance>;

export function getRecoveryGuidance(failureStage: FailureStage | null | undefined): RecoveryGuidance | null {
  if (!failureStage) {
    return null;
  }

  return recoveryCatalog[failureStage];
}
