import { createMockPodRuntime, type PodRuntime } from "#infra/runtime";

import {
  buildMockExitReceipt,
  buildMockFundingReceipt,
  type PrivacyAdapter,
  type PrivacyCapabilities,
  type PrepareExitInput,
  type PrepareFundingInput,
  type PrivacyReceipt,
} from "./privacy-adapter";

export class MockPrivacyAdapter implements PrivacyAdapter {
  constructor(private readonly podRuntime: PodRuntime = createMockPodRuntime()) {}

  capabilities(): PrivacyCapabilities {
    return {
      adapter: "mock",
      live: true,
      mvpReady: true,
      deterministicReceipts: true,
    };
  }

  async prepareFunding(input: PrepareFundingInput): Promise<PrivacyReceipt> {
    const pod = await this.podRuntime.createPod({
      positionId: input.positionId,
      mode: input.mode,
    });

    return buildMockFundingReceipt(pod.id, input);
  }

  async prepareExit(input: PrepareExitInput): Promise<PrivacyReceipt> {
    const pod = await this.podRuntime.createPod({
      positionId: input.positionId,
      mode: input.mode,
    });

    const closedPod = await this.podRuntime.closePod(pod.id);
    return buildMockExitReceipt(closedPod.id, input);
  }
}
