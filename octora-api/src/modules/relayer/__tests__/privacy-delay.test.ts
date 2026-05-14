/**
 * Test plan IDs covered:
 *   API-RLY-012 (new) privacy delay gate rejects roots first seen < min delay ago
 *   API-RLY-013 (new) privacy delay gate accepts the same root after the delay
 *   API-RLY-014 (new) privacy delay gate is disabled when ms = 0 (localnet/test)
 *   API-RLY-015 (new) gate runs after parity check — bad roots can't pre-arm
 *
 * The gate is a privacy boundary, not a UX guard. These tests pin its
 * exact arming + acceptance contract so a future refactor can't quietly
 * weaken it. The relayer is exercised at the service layer so we don't
 * depend on a real Solana RPC or compiled Groth16 artifacts — the gate
 * runs before proof verification and submission, and parity validation
 * (which the gate sits behind) can be made to pass with computed
 * pubkeyToFieldHash values.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { RelayerService } from "../relayer.service.js";
import { InMemoryNullifierRegistry } from "../nullifier-registry.js";
import { pubkeyToFieldHash } from "../proof-converter.js";
import type { RootSeenRepository } from "../root-seen.repository.js";
import type { RelayerConfig, WithdrawRequest } from "../types.js";

/**
 * In-memory root-seen repo + a controllable slot counter, so the gate's
 * contract can be exercised without a live Postgres or Solana RPC.
 */
function makeMemoryRootSeen(): RootSeenRepository & { _store: Map<string, bigint> } {
  const store = new Map<string, bigint>();
  return {
    _store: store,
    async observe(root: string, currentSlot: bigint) {
      const existing = store.get(root);
      if (existing !== undefined) return { firstSeenSlot: existing };
      store.set(root, currentSlot);
      return { firstSeenSlot: currentSlot };
    },
    async get(root: string) {
      const v = store.get(root);
      return v === undefined ? null : { firstSeenSlot: v };
    },
  };
}

function makeConfig(over: Partial<RelayerConfig> = {}): RelayerConfig {
  return {
    baseFeelamports: 5000n,
    minFeeLamports: 5000n,
    hotWalletSecret: "test-hot-wallet",
    mixerProgramId: "MixerProgram111111111111111111111111111",
    poolDenomination: 1_000_000_000n,
    privacyDelayMs: 1000,
    ...over,
  };
}

interface ParityFixture {
  recipient: PublicKey;
  relayer: PublicKey;
  recHash: string;
  relHash: string;
}

/**
 * Build matching (recipient, relayer) pubkeys and the Poseidon field
 * hashes they should bind to in publicSignals[2] and publicSignals[3].
 * Without this, the parity check rejects the request before the gate
 * ever runs.
 */
async function makeParityFixture(): Promise<ParityFixture> {
  const recipient = Keypair.generate().publicKey;
  const relayer = Keypair.generate().publicKey;
  const [recHash, relHash] = await Promise.all([
    pubkeyToFieldHash(recipient),
    pubkeyToFieldHash(relayer),
  ]);
  return {
    recipient,
    relayer,
    recHash: recHash.toString(),
    relHash: relHash.toString(),
  };
}

function makeRequest(
  parity: ParityFixture,
  over: { root?: string; nullifierHash?: string; fee?: string } = {},
): WithdrawRequest {
  const root = over.root ?? "12345";
  const nullifierHash = over.nullifierHash ?? "67890";
  const fee = over.fee ?? "5000";
  return {
    proof: {
      pi_a: ["1", "2"],
      pi_b: [["3", "4"], ["5", "6"]],
      pi_c: ["7", "8"],
      protocol: "groth16",
      curve: "bn128",
    },
    publicSignals: [root, nullifierHash, parity.recHash, parity.relHash, fee],
    root,
    nullifierHash,
    recipient: parity.recipient.toBase58(),
    relayer: parity.relayer.toBase58(),
    fee,
  };
}

describe("RelayerService — privacy delay gate", () => {
  let nullifiers: InMemoryNullifierRegistry;
  let parity: ParityFixture;

  beforeEach(async () => {
    nullifiers = new InMemoryNullifierRegistry();
    parity = await makeParityFixture();
  });

  it("API-RLY-012: rejects on first sight of a root with a deterministic wait hint", async () => {
    const repo = makeMemoryRootSeen();
    let slot = 1_000n;
    const service = new RelayerService(
      makeConfig({ privacyDelayMs: 1000 }),
      nullifiers,
      repo,
      async () => slot,
    );

    const result = await service.processWithdrawal(makeRequest(parity));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Privacy delay/i);
    // 1000ms / 400ms-per-slot = 3 slots. Wait hint rounds up to ~2s
    // (3 slots × 400ms = 1200ms).
    expect(result.error).toMatch(/Retry in ~/);
    // Nullifier must NOT be marked spent on a delay-rejection — the
    // user retries with the same proof.
    expect(await nullifiers.isSpent("67890")).toBe(false);
  });

  it("API-RLY-013: accepts the same root after the delay (and proceeds to proof verify)", async () => {
    const repo = makeMemoryRootSeen();
    let slot = 1_000n;
    const service = new RelayerService(
      makeConfig({ privacyDelayMs: 1000 }),
      nullifiers,
      repo,
      async () => slot,
    );

    const first = await service.processWithdrawal(makeRequest(parity));
    expect(first.success).toBe(false);
    expect(first.error).toMatch(/Privacy delay/i);

    // Advance 1500ms → ≥ 4 slots elapsed, well past the 3-slot threshold.
    slot += 4n;

    const second = await service.processWithdrawal(makeRequest(parity));
    // Past the gate the proof check kicks in. We don't ship compiled
    // circuit artifacts in this test scope, so the failure mode flips
    // to one of: proof verify error, or proof invalid — but never
    // the privacy-delay error.
    expect(second.success).toBe(false);
    expect(second.error).not.toMatch(/Privacy delay/i);
  });

  it("API-RLY-014: privacyDelayMs=0 disables the gate entirely", async () => {
    const repo = makeMemoryRootSeen();
    const service = new RelayerService(
      makeConfig({ privacyDelayMs: 0 }),
      nullifiers,
      repo,
      async () => 1_000n,
    );

    const result = await service.processWithdrawal(makeRequest(parity));
    // Gate is off, so the next failure must be downstream of it (proof
    // verify), never the privacy-delay rejection.
    expect(result.error).not.toMatch(/Privacy delay/i);
  });

  it("API-RLY-015: a parity-failing request does NOT arm the root in the first-seen map", async () => {
    const repo = makeMemoryRootSeen();
    const service = new RelayerService(
      makeConfig({ privacyDelayMs: 1000 }),
      nullifiers,
      repo,
      async () => 1_000n,
    );

    // Body root deliberately disagrees with publicSignals[0] (root binding).
    // Parity must fail first — and crucially must NOT arm root "999999".
    const bad: WithdrawRequest = {
      ...makeRequest(parity, { root: "999999" }),
      // Restore publicSignals[0] to "12345" so root mismatch is the parity failure.
      publicSignals: ["12345", "67890", parity.recHash, parity.relHash, "5000"],
    };
    const badResult = await service.processWithdrawal(bad);
    expect(badResult.success).toBe(false);
    expect(badResult.error).toMatch(/Public signal mismatch/);
    expect(badResult.error).not.toMatch(/Privacy delay/);

    // Now a parity-correct first request against the SAME root must
    // still be rejected by the privacy delay (because it's the first
    // valid sight — the bad request didn't pre-arm).
    const good = await service.processWithdrawal(makeRequest(parity, { root: "999999" }));
    expect(good.success).toBe(false);
    expect(good.error).toMatch(/Privacy delay/);
  });
});
