import { getRecoveryGuidance, recoveryCatalog, type ExecutionMode, type FailureStage, type RecoveryGuidance } from "#domain";

export interface RecoveryServiceInput {
  failureStage: FailureStage | null | undefined;
  mode: ExecutionMode;
}

export interface ResolveModeInput {
  selectedMode: ExecutionMode;
  fallbackMode?: ExecutionMode | null;
  surfacedFallback: boolean;
}

export interface ResolvedMode {
  mode: ExecutionMode;
  downgradedFrom: ExecutionMode | null;
  surfacedFallback: boolean;
}

export function createRecoveryService() {
  return {
    getRecoveryGuidance(input: RecoveryServiceInput): RecoveryGuidance | null {
      const guidance = getRecoveryGuidance(input.failureStage);
      if (!guidance?.surfaceDowngradeDisclosure || input.mode === "fast-private") {
        return guidance;
      }
      if (input.failureStage === "pre-funding") {
        return {
          headline: "Funding could not start",
          message: "Octora stopped before any funds moved. Check the balance, then retry from the beginning.",
          safeNextStep: "retry",
          terminal: true,
        };
      }
      if (input.failureStage === "funding-partial") {
        return {
          headline: "Funding started, but did not finish cleanly",
          message: "Octora moved into funding, but the flow did not complete. Check the wallet activity, then contact support before retrying.",
          safeNextStep: "contact-support",
          terminal: true,
        };
      }
      return guidance;
    },
    resolveExecutionMode(input: ResolveModeInput): ResolvedMode {
      const fallbackMode = input.fallbackMode ?? input.selectedMode;

      return {
        mode: fallbackMode,
        downgradedFrom: fallbackMode === input.selectedMode ? null : input.selectedMode,
        surfacedFallback: input.surfacedFallback,
      };
    },
    getIndexingRecovery(): RecoveryGuidance {
      return recoveryCatalog["indexing-lag"];
    },
  };
}
