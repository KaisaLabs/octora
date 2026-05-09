import type { ExecutionMode } from "#domain";
import type { PodRuntime } from "#infra/runtime";

export interface PrivacyCapabilities {
  adapter: "mock" | "magicblock" | "relayer";
  live: boolean;
  mvpReady: boolean;
  deterministicReceipts: boolean;
}

export interface PrepareFundingInput {
  positionId: string;
  intentId: string;
  poolSlug: string;
  amount: string;
  mode: ExecutionMode;
  /**
   * Optional client-provided stealth pubkey (base58). When set, the adapter
   * MUST use it as the funding/position owner rather than generating one
   * server-side. Used by the wallet-derived seed flow where the browser is
   * the sole holder of the stealth keypair and only sends the pubkey.
   */
  stealthPubkey?: string;
}

export interface PrepareExitInput {
  positionId: string;
  intentId: string;
  mode: ExecutionMode;
}

export interface PrivacyReceipt {
  receiptId: string;
  adapter: PrivacyCapabilities["adapter"];
  action: "prepare_funding" | "prepare_exit";
  positionId: string;
  podId: string | null;
  status: "prepared" | "not_live";
  summary: string;
  createdAtIso: string;
}

export interface PrivacyAdapter {
  capabilities(): PrivacyCapabilities;
  prepareFunding(input: PrepareFundingInput): Promise<PrivacyReceipt>;
  prepareExit(input: PrepareExitInput): Promise<PrivacyReceipt>;
}

export const MOCK_RECEIPT_TIMESTAMP_ISO = "2026-04-29T09:00:00.000Z";

export function buildMockFundingReceipt(podId: string, input: PrepareFundingInput): PrivacyReceipt {
  return {
    receiptId: `mock-funding-${input.positionId}`,
    adapter: "mock",
    action: "prepare_funding",
    positionId: input.positionId,
    podId,
    status: "prepared",
    summary: `Prepared mock funding path for position ${input.positionId}.`,
    createdAtIso: MOCK_RECEIPT_TIMESTAMP_ISO,
  };
}

export function buildMockExitReceipt(podId: string, input: PrepareExitInput): PrivacyReceipt {
  return {
    receiptId: `mock-exit-${input.positionId}`,
    adapter: "mock",
    action: "prepare_exit",
    positionId: input.positionId,
    podId,
    status: "prepared",
    summary: `Prepared mock exit path for position ${input.positionId}.`,
    createdAtIso: MOCK_RECEIPT_TIMESTAMP_ISO,
  };
}

export function assertLiveMvpAdapter(adapter: PrivacyCapabilities): void {
  if (!adapter.live) {
    throw new Error("This privacy adapter is not live.");
  }
}

export type { PodRuntime } from "#infra/runtime";
