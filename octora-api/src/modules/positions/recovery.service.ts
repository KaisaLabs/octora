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

export class SilentDowngradeError extends Error {
  constructor() {
    super("Fast Private fallback must be surfaced before execution starts");
    this.name = "SilentDowngradeError";
  }
}

export function createRecoveryService() {
  return {
    getRecoveryGuidance(input: RecoveryServiceInput): RecoveryGuidance | null {
      return getRecoveryGuidance(input.failureStage);
    },
    resolveExecutionMode(input: ResolveModeInput): ResolvedMode {
      const fallbackMode = input.fallbackMode ?? input.selectedMode;

      if (input.selectedMode === "fast-private" && fallbackMode !== input.selectedMode && !input.surfacedFallback) {
        throw new SilentDowngradeError();
      }

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
