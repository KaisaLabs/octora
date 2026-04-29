import type { ExecutionMode } from "./position-intent";

export const modePolicy = {
  standard: {
    label: "Standard",
    fundingTtlMinutes: 10,
    allowFallbackToStandard: false,
    podReuseWithinPosition: true,
  },
  "fast-private": {
    label: "Fast Private",
    fundingTtlMinutes: 15,
    allowFallbackToStandard: true,
    podReuseWithinPosition: true,
  },
} as const satisfies Record<
  ExecutionMode,
  {
    label: string;
    fundingTtlMinutes: number;
    allowFallbackToStandard: boolean;
    podReuseWithinPosition: boolean;
  }
>;

export type ModePolicy = (typeof modePolicy)[ExecutionMode];
