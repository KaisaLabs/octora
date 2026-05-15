/**
 * Tests for the close/03 user-signed close-recovery path.
 *
 * Load-bearing assertion (mirrors dust/04 / ADR-0004 for Flow 3):
 *   "Works against a stopped relayer (test by killing the relayer
 *    service before clicking)."
 *
 * The contract is that the user-signed close-recovery never depends on
 * the backend relayer. The frontend builds + signs + broadcasts the
 * recovery tx(s) itself; only afterwards does it call
 * `POST /positions/:positionId/close-recover` to record the audit row
 * + drive the state transition. To exercise that, the relayer-offline
 * suite wires a `PrivacyAdapter` whose every method throws so any
 * accidental call goes loud, then verifies the recover-close path
 * still lands the Position in `CLOSED` or `WITHDRAWN` based on
 * `recoveryAction`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createMemoryRepositories } from "#test-kit/memory-db";
import type { PrivacyAdapter } from "#modules/execution/adapters";
import { createMockMeteoraExecutor } from "#modules/execution/clients";

import {
  createPositionService,
  InvalidCloseRecoveryStateError,
} from "../position.service";

const WALLET = "TestWallet111111111111111111111111111111111";

/**
 * Privacy adapter stub that throws on every entry point. Wired so the
 * test fails loudly if a "relayer-offline" recovery path accidentally
 * reaches the relayer-driven privacy adapter — which would defeat the
 * ADR-0004 guarantee for Flow 3.
 */
function createOfflineRelayerAdapter(): PrivacyAdapter {
  const offline = () => {
    throw new Error(
      "Relayer is offline — user-signed close-recovery must not touch the privacy adapter.",
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

type FailedState = "CLOSE_FAILED" | "SWAP_FAILED" | "REMIX_FAILED";

async function seedFailedClosePosition(
  repos: ReturnType<typeof createMemoryRepositories>,
  positionId: string,
  state: FailedState,
): Promise<void> {
  await repos.positionRepo.createPosition({
    id: positionId,
    intentId: `intent-${positionId}`,
    walletAddress: WALLET,
    action: "add-liquidity",
    mode: "fast-private",
    state,
    poolSlug: "sol-usdc",
    amount: "1.0",
  });
  await repos.positionRepo.createExecutionSession({
    id: `session-${positionId}`,
    positionId,
    state,
    failureStage:
      state === "CLOSE_FAILED"
        ? "close-submission"
        : state === "SWAP_FAILED"
          ? "swap-submission"
          : "remix-submission",
  });
  await repos.activityRepo.createActivity({
    id: `activity-${positionId}`,
    positionId,
    action: "add-liquidity",
    state,
    headline: `${state} reached`,
    detail: "Pre-test seed.",
    safeNextStep: "contact-support",
  });
}

describe("user-signed close-recovery (close/03) — relayer-offline contract", () => {
  let repos = createMemoryRepositories();

  beforeEach(() => {
    repos = createMemoryRepositories();
  });

  const failedStates: FailedState[] = ["CLOSE_FAILED", "SWAP_FAILED", "REMIX_FAILED"];

  for (const state of failedStates) {
    it(`drives ${state} -> CLOSED (complete-close) under a throwing PrivacyAdapter`, async () => {
      const positionId = `pos_recover_${state}_close`;
      await seedFailedClosePosition(repos, positionId, state);

      const service = createPositionService({
        ...repos,
        privacyAdapter: createOfflineRelayerAdapter(),
        meteoraExecutor: createMockMeteoraExecutor(),
      });

      const result = await service.recoverCloseUserSigned({
        positionId,
        recoveryAction: "complete-close",
        txSignature: "5HJ8e6...userSignedCloseRecoverySig...VgYx",
        recipient: "FreshRecipientAddr11111111111111111111111111",
      });

      expect(result.position.state).toBe("CLOSED");
      expect(result.session.state).toBe("CLOSED");
      expect(result.position.statusLabel).toBe("Closed privately");

      // Activity log: dust/04-style audit row + the close service's
      // terminal "Closed privately" row.
      const headlines = result.activity.map((a) => a.headline);
      expect(headlines).toContain("User-signed close-recovery submitted");
      expect(headlines).toContain("Closed privately");

      const auditRow = result.activity.find(
        (a) => a.headline === "User-signed close-recovery submitted",
      );
      expect(auditRow?.detail).toContain("without the backend relayer");
      expect(auditRow?.detail).toContain("completed the close");
      expect(auditRow?.detail).toContain("FreshRecipientAddr");
      expect(auditRow?.detail).toContain("5HJ8e6");
      expect(auditRow?.detail).toContain("linkable");
    });

    it(`drives ${state} -> WITHDRAWN (bail-to-withdrawn) under a throwing PrivacyAdapter`, async () => {
      const positionId = `pos_recover_${state}_bail`;
      await seedFailedClosePosition(repos, positionId, state);

      const service = createPositionService({
        ...repos,
        privacyAdapter: createOfflineRelayerAdapter(),
        meteoraExecutor: createMockMeteoraExecutor(),
      });

      const result = await service.recoverCloseUserSigned({
        positionId,
        recoveryAction: "bail-to-withdrawn",
        txSignature: "BailSig111...",
        recipient: "BailDestination222",
      });

      expect(result.position.state).toBe("WITHDRAWN");
      expect(result.session.state).toBe("WITHDRAWN");
      expect(result.position.statusLabel).toBe("Recovered");

      const headlines = result.activity.map((a) => a.headline);
      expect(headlines).toContain("User-signed close-recovery submitted");
      expect(headlines).toContain("Recovered");

      const auditRow = result.activity.find(
        (a) => a.headline === "User-signed close-recovery submitted",
      );
      expect(auditRow?.detail).toContain("bailed to a direct withdraw");
      expect(auditRow?.detail).toContain("BailDestination222");
    });
  }

  it("refuses to recover from a non-*_FAILED state with a typed error", async () => {
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
      service.recoverCloseUserSigned({
        positionId,
        recoveryAction: "complete-close",
      }),
    ).rejects.toBeInstanceOf(InvalidCloseRecoveryStateError);
  });

  it("records the terminal transition even when the caller supplies no signature evidence", async () => {
    // The signature is optional — funds are safe whether or not the
    // browser passes a signature back to the backend. State must
    // still advance.
    const positionId = "pos_recover_no_sig";
    await seedFailedClosePosition(repos, positionId, "REMIX_FAILED");

    const service = createPositionService({
      ...repos,
      privacyAdapter: createOfflineRelayerAdapter(),
      meteoraExecutor: createMockMeteoraExecutor(),
    });

    const result = await service.recoverCloseUserSigned({
      positionId,
      recoveryAction: "bail-to-withdrawn",
    });
    expect(result.position.state).toBe("WITHDRAWN");
  });
});
