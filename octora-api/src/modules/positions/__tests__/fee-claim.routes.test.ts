/**
 * Route-level coverage for close/05.
 *
 * Asserts:
 *   - `POST /positions/:positionId/claim-fees` 200s on an `active`
 *     Position; 409 on a non-`active` source state.
 *   - `POST /positions/:positionId/claim-fees/remix` 200s on an
 *     `active` Position; 409 on a non-`active` source state.
 *   - Owner-check fires: wrong wallet → 403.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "#app";
import { createMemoryRepositories } from "#test-kit/memory-db";
import { testWalletStamper } from "#test-kit/route-harness";

// Valid base58 Solana pubkeys — the testWalletStamper actually validates
// these through `new PublicKey(...)` before stamping `req.wallet`, so an
// invalid placeholder string silently falls back to the default and the
// owner check returns 403.
const WALLET = "11111111111111111111111111111111";
const OTHER_WALLET = "So11111111111111111111111111111111111111112";

async function seedActive(
  repos: ReturnType<typeof createMemoryRepositories>,
  positionId: string,
  state: string,
  walletAddress = WALLET,
) {
  await repos.positionRepo.createPosition({
    id: positionId,
    intentId: `intent_${positionId}`,
    walletAddress,
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
    headline: "Position active",
    detail: "Seeded.",
    safeNextStep: "wait",
  });
}

async function buildApp() {
  const repos = createMemoryRepositories();
  const app = await createApp({
    repos,
    authPreHandlers: [testWalletStamper],
    logger: false,
  });
  return { app, repos };
}

describe("claim-fees + remix routes (close/05)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let repos: Awaited<ReturnType<typeof buildApp>>["repos"];

  beforeEach(async () => {
    ({ app, repos } = await buildApp());
  });

  it("POST /claim-fees on an active Position returns the claim receipt", async () => {
    await seedActive(repos, "pos_active", "active");

    const res = await app.inject({
      method: "POST",
      url: "/positions/pos_active/claim-fees",
      headers: { "x-wallet-address": WALLET },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      position: { state: string };
      claimedSolLamports: string;
      claimedOtherLamports: string;
      signature: string;
      activity: Array<{ state: string; headline: string }>;
    };
    expect(body.position.state).toBe("active");
    expect(BigInt(body.claimedSolLamports)).toBeGreaterThan(0n);
    expect(body.signature).toMatch(/^mock-meteora-claim-/);
    expect(body.activity.map((a) => a.headline)).toContain(
      "Fees claimed to Stealth Wallet",
    );
  });

  it("POST /claim-fees on a non-active Position returns 409 with a typed code", async () => {
    await seedActive(repos, "pos_draft", "draft");

    const res = await app.inject({
      method: "POST",
      url: "/positions/pos_draft/claim-fees",
      headers: { "x-wallet-address": WALLET },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as { code?: string; message: string };
    expect(body.code).toBe("fee_claim_invalid_state");
    expect(body.message).toMatch(/active/i);
  });

  it("POST /claim-fees from a different wallet returns 403", async () => {
    await seedActive(repos, "pos_owned", "active");

    const res = await app.inject({
      method: "POST",
      url: "/positions/pos_owned/claim-fees",
      headers: { "x-wallet-address": OTHER_WALLET },
    });

    expect(res.statusCode).toBe(403);
  });

  it("POST /claim-fees/remix records a fee-claim-sourced re-mix", async () => {
    await seedActive(repos, "pos_remix", "active");

    const res = await app.inject({
      method: "POST",
      url: "/positions/pos_remix/claim-fees/remix",
      headers: { "x-wallet-address": WALLET },
      payload: {
        denomLamports: "100000000",
        commitment: "0xdead",
        leafIndex: 3,
        txSignature: "mock-sig",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      source: string;
      remixedLamports: string;
      commitment: string;
      leafIndex: number;
      activity: Array<{ headline: string; detail: string }>;
    };
    expect(body.source).toBe("fee-claim");
    expect(body.remixedLamports).toBe("100000000");
    expect(body.commitment).toBe("0xdead");
    expect(body.leafIndex).toBe(3);
    const remixActivity = body.activity.find((a) => a.headline === "Fees re-mixed");
    expect(remixActivity?.detail).toContain("Source: fee-claim");
  });

  it("POST /claim-fees/remix on a non-active Position returns 409", async () => {
    await seedActive(repos, "pos_closed", "completed");

    const res = await app.inject({
      method: "POST",
      url: "/positions/pos_closed/claim-fees/remix",
      headers: { "x-wallet-address": WALLET },
      payload: { denomLamports: "100000000" },
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code?: string }).code).toBe("fee_claim_invalid_state");
  });
});
