/**
 * Two-phase Private Deposit -> Position Open state machine (dust/03 +
 * ADR-0004). Asserts the four required paths through the Deposit LP
 * Fallback sub-state cluster end-to-end, including persisted intent
 * lifecycle.
 *
 * Each test seeds a Position at `awaiting_signature` (the natural entry
 * state from the `createIntent` route — `awaiting_signature -> DEPOSITED`
 * is a permitted transition in the existing state machine), then drives
 * the service methods that wrap the aggregate's `advance` guard.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createMemoryRepositories } from "#test-kit/memory-db";

import { createPositionService, DepositLpStateTransitionError } from "../position.service";

const WALLET = "TestWallet111111111111111111111111111111111";

interface SeedOpts {
  state?: string;
  positionId?: string;
}

async function seedPosition(
  repos: ReturnType<typeof createMemoryRepositories>,
  { state = "awaiting_signature", positionId = "pos_dlp" }: SeedOpts = {},
) {
  await repos.positionRepo.createPosition({
    id: positionId,
    intentId: `intent_${positionId}`,
    walletAddress: WALLET,
    action: "add-liquidity",
    mode: "fast-private",
    state,
    poolSlug: "sol-usdc",
    amount: "1.0",
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
    headline: "Intent received",
    detail: "Queued a draft SOL / USDC position for signature review.",
    safeNextStep: "wait",
  });
  return positionId;
}

const depositInput = (positionId: string) => ({
  positionId,
  nullifierHash: `nullifier_${positionId}`,
  commitment: `commitment_${positionId}`,
  intendedPool: "sol-usdc",
  denomLamports: "1000000000",
});

describe("Deposit LP Fallback state machine — dust/03", () => {
  let repos = createMemoryRepositories();

  beforeEach(() => {
    repos = createMemoryRepositories();
  });

  it("happy path: DEPOSITED -> LP_PENDING -> LP_DONE clears the persisted intent", async () => {
    const positionId = await seedPosition(repos);
    const service = createPositionService(repos);

    const afterDeposit = await service.recordDeposit(depositInput(positionId));
    expect(afterDeposit.position.state).toBe("DEPOSITED");
    expect(afterDeposit.position.statusLabel).toBe("Deposit confirmed");
    // Intent is persisted on DEPOSITED.
    expect(await repos.positionRepo.getDepositIntent(`nullifier_${positionId}`)).not.toBeNull();

    const afterPending = await service.markLpPending(positionId);
    expect(afterPending.position.state).toBe("LP_PENDING");
    expect(afterPending.position.statusLabel).toBe("Adding liquidity");

    const afterDone = await service.markLpDone(positionId);
    expect(afterDone.position.state).toBe("LP_DONE");
    // LP_DONE is terminal and clears the persisted intent.
    expect(await repos.positionRepo.getDepositIntent(`nullifier_${positionId}`)).toBeNull();
  });

  it("LP_FAILED -> LP_RETRIED -> LP_DONE keeps the persisted intent until completion", async () => {
    const positionId = await seedPosition(repos);
    const service = createPositionService(repos);

    await service.recordDeposit(depositInput(positionId));
    await service.markLpPending(positionId);
    const afterFail = await service.markLpFailed(positionId, "Meteora dropped the tx.");
    expect(afterFail.position.state).toBe("LP_FAILED");
    expect(afterFail.position.statusLabel).toBe("Add liquidity failed");
    // Intent stays — the user can still retry, park, or withdraw.
    expect(await repos.positionRepo.getDepositIntent(`nullifier_${positionId}`)).not.toBeNull();

    const afterRetry = await service.retryLp(positionId);
    expect(afterRetry.position.state).toBe("LP_RETRIED");

    const afterDone = await service.markLpDone(positionId);
    expect(afterDone.position.state).toBe("LP_DONE");
    expect(await repos.positionRepo.getDepositIntent(`nullifier_${positionId}`)).toBeNull();
  });

  it("LP_FAILED -> PARKED -> LP_RETRIED resumes correctly without clearing intent", async () => {
    const positionId = await seedPosition(repos);
    const service = createPositionService(repos);

    await service.recordDeposit(depositInput(positionId));
    await service.markLpPending(positionId);
    await service.markLpFailed(positionId, "User left the page.");

    const parked = await service.parkLp(positionId);
    expect(parked.position.state).toBe("PARKED");
    expect(parked.position.statusLabel).toBe("Parked for later");
    // Persisted intent survives PARKED.
    expect(await repos.positionRepo.getDepositIntent(`nullifier_${positionId}`)).not.toBeNull();

    const retried = await service.retryLp(positionId);
    expect(retried.position.state).toBe("LP_RETRIED");
    expect(await repos.positionRepo.getDepositIntent(`nullifier_${positionId}`)).not.toBeNull();
  });

  it("LP_FAILED -> WITHDRAWN is permitted (dust/04 wires the user-signed tx itself)", async () => {
    const positionId = await seedPosition(repos);
    const service = createPositionService(repos);

    await service.recordDeposit(depositInput(positionId));
    await service.markLpPending(positionId);
    await service.markLpFailed(positionId, "Meteora dropped the tx.");

    // dust/03 only asserts the transition is permitted; the actual
    // user-signed Recover Funds tx lives in dust/04.
    const withdrawn = await service.markWithdrawn(positionId);
    expect(withdrawn.position.state).toBe("WITHDRAWN");
    expect(withdrawn.position.statusLabel).toBe("Recovered");
    // WITHDRAWN is terminal and clears the persisted intent.
    expect(await repos.positionRepo.getDepositIntent(`nullifier_${positionId}`)).toBeNull();
  });

  it("rejects illegal transitions via the state-machine guard", async () => {
    const positionId = await seedPosition(repos);
    const service = createPositionService(repos);

    await service.recordDeposit(depositInput(positionId));

    // Skipping LP_PENDING — DEPOSITED -> LP_DONE is not allowed.
    await expect(service.markLpDone(positionId)).rejects.toBeInstanceOf(
      DepositLpStateTransitionError,
    );

    // DEPOSITED -> PARKED is not allowed without going through LP_FAILED.
    await expect(service.parkLp(positionId)).rejects.toBeInstanceOf(
      DepositLpStateTransitionError,
    );

    // DEPOSITED -> WITHDRAWN is not allowed.
    await expect(service.markWithdrawn(positionId)).rejects.toBeInstanceOf(
      DepositLpStateTransitionError,
    );

    // From PARKED, retry is allowed; jumping to LP_DONE is not.
    await service.markLpPending(positionId);
    await service.markLpFailed(positionId, "test");
    await service.parkLp(positionId);
    await expect(service.markLpDone(positionId)).rejects.toBeInstanceOf(
      DepositLpStateTransitionError,
    );
  });

  it("WITHDRAWN is terminal — no further transitions accepted", async () => {
    const positionId = await seedPosition(repos);
    const service = createPositionService(repos);

    await service.recordDeposit(depositInput(positionId));
    await service.markLpPending(positionId);
    await service.markLpFailed(positionId, "test");
    await service.markWithdrawn(positionId);

    await expect(service.retryLp(positionId)).rejects.toBeInstanceOf(
      DepositLpStateTransitionError,
    );
    await expect(service.markLpDone(positionId)).rejects.toBeInstanceOf(
      DepositLpStateTransitionError,
    );
  });

  it("LP_DONE is terminal — no further transitions accepted", async () => {
    const positionId = await seedPosition(repos);
    const service = createPositionService(repos);

    await service.recordDeposit(depositInput(positionId));
    await service.markLpPending(positionId);
    await service.markLpDone(positionId);

    await expect(service.markLpFailed(positionId, "test")).rejects.toBeInstanceOf(
      DepositLpStateTransitionError,
    );
    await expect(service.markWithdrawn(positionId)).rejects.toBeInstanceOf(
      DepositLpStateTransitionError,
    );
  });
});

describe("Persisted Deposit Intent — repository contract", () => {
  it("getDepositIntent returns the row that was persisted", async () => {
    const repos = createMemoryRepositories();
    const expiresAt = new Date("2026-12-31T00:00:00.000Z");
    await repos.positionRepo.persistDepositIntent({
      nullifierHash: "n1",
      positionId: "p1",
      commitment: "c1",
      intendedPool: "sol-usdc",
      denom: "1000000000",
      expiresAt,
    });

    const row = await repos.positionRepo.getDepositIntent("n1");
    expect(row).toMatchObject({
      nullifierHash: "n1",
      positionId: "p1",
      commitment: "c1",
      intendedPool: "sol-usdc",
      denom: "1000000000",
    });
    expect(row?.expiresAt.toISOString()).toBe(expiresAt.toISOString());
  });

  it("clearDepositIntentForPosition removes the row keyed by positionId", async () => {
    const repos = createMemoryRepositories();
    await repos.positionRepo.persistDepositIntent({
      nullifierHash: "n2",
      positionId: "p2",
      commitment: "c2",
      intendedPool: "sol-usdc",
      denom: "1000000000",
      expiresAt: new Date("2026-12-31T00:00:00.000Z"),
    });

    await repos.positionRepo.clearDepositIntentForPosition("p2");
    expect(await repos.positionRepo.getDepositIntent("n2")).toBeNull();
  });

  it("clearDepositIntent is a no-op when the nullifier hash is unknown", async () => {
    const repos = createMemoryRepositories();
    await expect(repos.positionRepo.clearDepositIntent("unknown")).resolves.toBeUndefined();
  });
});
