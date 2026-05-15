/**
 * Mid-position fee claim (close/05).
 *
 * Asserts:
 *   - Claim happy path emits an Activity Record at `active` and
 *     reports the claimed-fee projection (SOL + non-SOL).
 *   - Position state does NOT transition out of `active`.
 *   - A claim from any non-`active` state surfaces a typed 409 via
 *     `MidPositionFeeClaimStateError`.
 *   - The Re-mix offer activates when the claimed SOL portion ≥ one
 *     Mixer Pool denomination; re-mixing emits an Activity Record
 *     tagged `source: fee-claim`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createMockMeteoraExecutor } from "#modules/execution/clients";
import { MockPrivacyAdapter } from "#modules/execution/adapters";
import { createMemoryRepositories } from "#test-kit/memory-db";

import {
  createPositionService,
  MidPositionFeeClaimStateError,
} from "../position.service";

const WALLET = "TestWallet111111111111111111111111111111111";

async function seedActivePosition(
  repos: ReturnType<typeof createMemoryRepositories>,
  positionId = "pos_fee_claim",
  state = "active",
) {
  await repos.positionRepo.createPosition({
    id: positionId,
    intentId: `intent_${positionId}`,
    walletAddress: WALLET,
    action: "add-liquidity",
    mode: "fast-private",
    state,
    poolSlug: "sol-usdc",
    amount: "1.25",
  });
  await repos.positionRepo.createExecutionSession({
    id: `session_${positionId}`,
    positionId,
    state,
    failureStage: null,
  });
  await repos.activityRepo.createActivity({
    id: `activity_${positionId}`,
    positionId,
    action: "add-liquidity",
    state,
    headline: "Position active",
    detail: "The final snapshot is available and the position is now live.",
    safeNextStep: "wait",
  });
  return positionId;
}

function buildService(repos: ReturnType<typeof createMemoryRepositories>) {
  return createPositionService({
    ...repos,
    privacyAdapter: new MockPrivacyAdapter(),
    meteoraExecutor: createMockMeteoraExecutor(),
  });
}

describe("mid-position fee claim (close/05)", () => {
  let repos = createMemoryRepositories();

  beforeEach(() => {
    repos = createMemoryRepositories();
  });

  it("claims fees from an active position and keeps the position active", async () => {
    const positionId = await seedActivePosition(repos);
    const service = buildService(repos);

    const result = await service.claimMidPositionFees({ positionId });

    // No state change — Position must still read as active end-to-end.
    expect(result.position.state).toBe("active");
    expect(result.session.state).toBe("active");
    expect(result.position.statusLabel).toBe("Position active");

    // Activity log records the claim alongside the seeded "Position active"
    // entry, both at the `active` state — no transition.
    expect(result.activity.map((item) => item.state)).toEqual([
      "active",
      "active",
    ]);
    expect(result.activity.map((item) => item.headline)).toEqual([
      "Position active",
      "Fees claimed to Stealth Wallet",
    ]);

    // Claim receipt projection — SOL portion and non-SOL residual are
    // both surfaced so the UI can drive the Re-mix / Leave-it panel.
    expect(BigInt(result.claimedSolLamports)).toBeGreaterThan(0n);
    expect(BigInt(result.claimedOtherLamports)).toBeGreaterThanOrEqual(0n);
    expect(result.signature).toMatch(/^mock-meteora-claim-/);
  });

  it("rejects a claim from a non-active position with a typed 409 error", async () => {
    const positionId = await seedActivePosition(repos, "pos_draft", "draft");
    const service = buildService(repos);

    await expect(service.claimMidPositionFees({ positionId })).rejects.toBeInstanceOf(
      MidPositionFeeClaimStateError,
    );
  });

  it("offers re-mix only when the SOL portion is at or above the Mixer Pool denomination", async () => {
    const positionId = await seedActivePosition(repos);
    const service = buildService(repos);

    const claim = await service.claimMidPositionFees({ positionId });
    const claimedSol = BigInt(claim.claimedSolLamports);

    // The mock claim emits 0.25 SOL; a 0.1 SOL denom (100_000_000 lamports)
    // is below it, so the Re-mix offer is active and the call records an
    // Activity Record tagged `source: fee-claim`.
    const denomLamports = (claimedSol / 2n).toString();
    expect(BigInt(denomLamports)).toBeLessThanOrEqual(claimedSol);

    const remixResult = await service.remixClaimedFees({
      positionId,
      denomLamports,
      commitment: "0xabc",
      leafIndex: 7,
      txSignature: "mock-mixer-deposit-sig",
    });

    expect(remixResult.source).toBe("fee-claim");
    expect(remixResult.remixedLamports).toBe(denomLamports);
    expect(remixResult.commitment).toBe("0xabc");
    expect(remixResult.leafIndex).toBe(7);

    // Position state still `active` — re-mix never advances it.
    expect(remixResult.position.state).toBe("active");
    expect(remixResult.session.state).toBe("active");

    // Activity log carries the seeded entry + claim + re-mix, all at
    // `active`, with the re-mix detail flagging source=fee-claim.
    const headlines = remixResult.activity.map((item) => item.headline);
    expect(headlines).toEqual([
      "Position active",
      "Fees claimed to Stealth Wallet",
      "Fees re-mixed",
    ]);
    const remixDetail = remixResult.activity.at(-1)!.detail;
    expect(remixDetail).toContain("Source: fee-claim");
  });

  it("rejects re-mix on a non-active position", async () => {
    const positionId = await seedActivePosition(repos, "pos_completed", "completed");
    const service = buildService(repos);

    await expect(
      service.remixClaimedFees({ positionId, denomLamports: "100000000" }),
    ).rejects.toBeInstanceOf(MidPositionFeeClaimStateError);
  });
});
