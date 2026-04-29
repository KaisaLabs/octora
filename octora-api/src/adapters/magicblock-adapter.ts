import type { PrivacyAdapter, PrivacyCapabilities, PrepareExitInput, PrepareFundingInput, PrivacyReceipt } from "./privacy-adapter";

export interface MagicBlockAdapterOptions {
  reason?: string;
}

export class MagicBlockAdapter implements PrivacyAdapter {
  private readonly reason: string;

  constructor(options: MagicBlockAdapterOptions = {}) {
    this.reason = options.reason ?? "MagicBlock integration is not live in the MVP.";
  }

  capabilities(): PrivacyCapabilities {
    return {
      adapter: "magicblock",
      live: false,
      mvpReady: false,
      deterministicReceipts: false,
    };
  }

  async prepareFunding(_input: PrepareFundingInput): Promise<PrivacyReceipt> {
    throw new Error(`${this.reason} Use MockPrivacyAdapter for the product path.`);
  }

  async prepareExit(_input: PrepareExitInput): Promise<PrivacyReceipt> {
    throw new Error(`${this.reason} Use MockPrivacyAdapter for the product path.`);
  }
}
