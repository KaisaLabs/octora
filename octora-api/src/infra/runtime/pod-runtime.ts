import type { ExecutionMode } from "#domain";

export interface CreatePodInput {
  positionId: string;
  mode: ExecutionMode;
}

export interface PodRecord {
  id: string;
  positionId: string;
  mode: ExecutionMode;
  status: PodStatus;
  createdAtIso: string;
  closedAtIso: string | null;
}

export type PodStatus = "open" | "closed";

export interface PodRuntime {
  createPod(input: CreatePodInput): Promise<PodRecord>;
  getPod(podId: string): Promise<PodRecord | null>;
  closePod(podId: string): Promise<PodRecord>;
}

const MOCK_POD_TIMESTAMP_ISO = "2026-04-29T09:00:00.000Z";

export class MockPodRuntime implements PodRuntime {
  private readonly pods = new Map<string, PodRecord>();

  async createPod(input: CreatePodInput): Promise<PodRecord> {
    const podId = formatPodId(input.positionId);
    const existing = this.pods.get(podId);
    if (existing) {
      return existing;
    }

    const pod: PodRecord = {
      id: podId,
      positionId: input.positionId,
      mode: input.mode,
      status: "open",
      createdAtIso: MOCK_POD_TIMESTAMP_ISO,
      closedAtIso: null,
    };

    this.pods.set(podId, pod);
    return pod;
  }

  async getPod(podId: string): Promise<PodRecord | null> {
    return this.pods.get(podId) ?? null;
  }

  async closePod(podId: string): Promise<PodRecord> {
    const pod = this.pods.get(podId);
    if (!pod) {
      throw new Error(`Pod ${podId} not found`);
    }

    if (pod.status === "closed") {
      return pod;
    }

    const closedPod: PodRecord = {
      ...pod,
      status: "closed",
      closedAtIso: MOCK_POD_TIMESTAMP_ISO,
    };

    this.pods.set(podId, closedPod);
    return closedPod;
  }
}

export function createMockPodRuntime(): PodRuntime {
  return new MockPodRuntime();
}

function formatPodId(positionId: string) {
  return `pod-${positionId}`;
}
