/**
 * Tests for the dust/04 user-signed Recover Funds path.
 *
 * Load-bearing assertion (per ADR-0004 + ticket dust/04 AC):
 *   "Works against a stopped relayer (test by killing the relayer
 *    service before clicking)."
 *
 * The contract is that the user-signed recovery never depends on the
 * backend relayer. The frontend builds + signs + broadcasts the
 * `mixer.withdraw` itself; only afterwards does it call
 * `POST /positions/:positionId/recover-funds` to record the audit row +
 * drive the state transition. To exercise that, the relayer-offline
 * suite below wires a `PrivacyAdapter` whose every method throws so any
 * accidental call goes loud, then verifies the recover-funds path still
 * lands the Position in `WITHDRAWN`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createMemoryRepositories } from "#test-kit/memory-db";
import type { PrivacyAdapter } from "#modules/execution/adapters";
import { createMockMeteoraExecutor } from "#modules/execution/clients";

import { createPositionService, InvalidRecoveryStateError } from "../position.service";

const WALLET = "TestWallet111111111111111111111111111111111";

/**
 * Privacy adapter stub that throws on every entry point. Wired into the
 * service so the test fails loudly if a "relayer-offline" recovery path
 * accidentally reaches the relayer-driven privacy adapter — which would
 * defeat the ADR-0004 guarantee.
 */
function createOfflineRelayerAdapter(): PrivacyAdapter {
  const offline = () => {
    throw new Error(
      "Relayer is offline — user-signed Recover Funds must not touch the privacy adapter.",
    );
  };
  return {
    async prepareFunding() {
      return offline();
    },
    async prepareExit() {
      return offline();
    },
  } as unknown as PrivacyAdapter;
}

async function seedLpFailedPosition(
  repos: ReturnType<typeof createMemoryRepositories>,
  positionId: string,
): Promise<void> {
  await repos.positionRepo.createPosition({
    id: positionId,
    intentId: `intent-${positionId}`,
    walletAddress: WALLET,
    action: "add-liquidity",
    mode: "fast-private",
    state: "LP_FAILED",
    poolSlug: "sol-usdc",
    amount: "1.0",
  });
  await repos.positionRepo.createExecutionSession({
    id: `session-${positionId}`,
    positionId,
    state: "LP_FAILED",
    failureStage: null,
  });
  await repos.activityRepo.createActivity({
    id: `activity-${positionId}`,
    positionId,
    action: "add-liquidity",
    state: "LP_FAILED",
    headline: "Add liquidity failed",
    detail: "Pre-test seed.",
    safeNextStep: "retry",
  });
  // Persist a deposit intent so we can assert it's cleared on WITHDRAWN.
  await repos.positionRepo.persistDepositIntent({
    nullifierHash: `nullifier-${positionId}`,
    positionId,
    commitment: "0xdeadbeef",
    intendedPool: "sol-usdc",
    denom: "1000000000",
    expiresAt: new Date("2030-01-01T00:00:00Z"),
  });
}

describe("user-signed Recover Funds (dust/04) — relayer-offline contract", () => {
  let repos = createMemoryRepositories();

  beforeEach(() => {
    repos = createMemoryRepositories();
  });

  it("drives LP_FAILED → WITHDRAWN even when the relayer adapter throws on every call", async () => {
    const positionId = "pos_recover_lp_failed";
    await seedLpFailedPosition(repos, positionId);

    const service = createPositionService({
      ...repos,
      privacyAdapter: createOfflineRelayerAdapter(),
      meteoraExecutor: createMockMeteoraExecutor(),
    });

    // The browser already broadcast the user-signed mixer.withdraw and
    // confirmed it on chain. The backend's job is just to flip state.
    const result = await service.recoverFundsUserSigned({
      positionId,
      withdrawSignature: "5HJ8e6...userSignedRecoverySignature...VgYx",
      withdrawRecipient: "FreshStealthAddr111111111111111111111111111",
    });

    expect(result.position.state).toBe("WITHDRAWN");
    expect(result.session.state).toBe("WITHDRAWN");
    expect(result.position.statusLabel).toBe("Recovered");

    // Activity log captures both the dust/04 audit row (with the
    // user-signed evidence) AND the dust/03 terminal "Recovered" row.
    const headlines = result.activity.map((a) => a.headline);
    expect(headlines).toContain("User-signed recovery submitted");
    expect(headlines).toContain("Recovered");

    const auditRow = result.activity.find(
      (a) => a.headline === "User-signed recovery submitted",
    );
    expect(auditRow?.detail).toContain("signed a mixer.withdraw");
    expect(auditRow?.detail).toContain("without the backend relayer");
    expect(auditRow?.detail).toContain("FreshStealthAddr");
    expect(auditRow?.detail).toContain("5HJ8e6");
    expect(auditRow?.detail).toContain("linkable");

    // dust/03 contract — persisted deposit intent cleared on WITHDRAWN.
    expect(
      await repos.positionRepo.getDepositIntent(`nullifier-${positionId}`),
    ).toBeNull();
  });

  it("drives PARKED → WITHDRAWN with the same relayer-offline guarantee", async () => {
    const positionId = "pos_recover_parked";
    await seedLpFailedPosition(repos, positionId);
    // Walk LP_FAILED → PARKED via the documented machine path.
    await repos.positionRepo.updatePositionState(positionId, "PARKED");
    await repos.positionRepo.updateExecutionSession(positionId, "PARKED");

    const service = createPositionService({
      ...repos,
      privacyAdapter: createOfflineRelayerAdapter(),
      meteoraExecutor: createMockMeteoraExecutor(),
    });

    const result = await service.recoverFundsUserSigned({
      positionId,
      withdrawSignature: "ParkedRecoverySig",
      withdrawRecipient: "FreshStealthFromParked",
    });

    expect(result.position.state).toBe("WITHDRAWN");
    expect(result.session.state).toBe("WITHDRAWN");
  });

  it("refuses to recover from a non-LP_FAILED/PARKED state with a typed error", async () => {
    const positionId = "pos_recover_invalid";
    await repos.positionRepo.createPosition({
      id: positionId,
      intentId: `intent-${positionId}`,
      walletAddress: WALLET,
      action: "add-liquidity",
      mode: "fast-private",
      state: "active",
      poolSlug: "sol-usdc",
      amount: "1.0",
    });
    await repos.positionRepo.createExecutionSession({
      id: `session-${positionId}`,
      positionId,
      state: "active",
      failureStage: null,
    });
    await repos.activityRepo.createActivity({
      id: `activity-${positionId}`,
      positionId,
      action: "add-liquidity",
      state: "active",
      headline: "Position active",
      detail: "Pre-test seed.",
      safeNextStep: "wait",
    });

    const service = createPositionService({
      ...repos,
      privacyAdapter: createOfflineRelayerAdapter(),
      meteoraExecutor: createMockMeteoraExecutor(),
    });

    await expect(
      service.recoverFundsUserSigned({ positionId }),
    ).rejects.toBeInstanceOf(InvalidRecoveryStateError);
  });

  it("records the WITHDRAWN transition even when the caller supplies no signature evidence", async () => {
    // The signature is optional — the funds are safe whether or not the
    // browser passes a signature back to the backend. The state should
    // still advance.
    const positionId = "pos_recover_no_sig";
    await seedLpFailedPosition(repos, positionId);

    const service = createPositionService({
      ...repos,
      privacyAdapter: createOfflineRelayerAdapter(),
      meteoraExecutor: createMockMeteoraExecutor(),
    });

    const result = await service.recoverFundsUserSigned({ positionId });
    expect(result.position.state).toBe("WITHDRAWN");
  });
});
