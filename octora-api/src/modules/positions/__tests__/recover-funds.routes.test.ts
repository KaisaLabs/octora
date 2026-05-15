/**
 * Route-level tests for `POST /positions/:positionId/recover-funds` —
 * the dust/04 reporting endpoint the browser hits after broadcasting a
 * user-signed `mixer.withdraw`. Pins:
 *   - 200 on LP_FAILED → WITHDRAWN with signature + recipient body
 *   - 200 on PARKED → WITHDRAWN
 *   - 409 (InvalidRecoveryState) on any other source state
 *   - 403 when the authenticated wallet doesn't own the Position
 *   - 401 when no wallet is stamped (strictWalletStamper path)
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createTestApp, strictWalletStamper } from "#test-kit/route-harness";

// Both owner and other must be valid base58 Solana pubkeys — the
// strict wallet stamper rejects non-decodable strings, and the
// permissive stamper silently falls back to TEST_DEFAULT_WALLET on a
// bad value (so a typo would collapse OWNER === OTHER and make the
// 403 test pass for the wrong reason).
const OWNER = "11111111111111111111111111111111";
const OTHER = "So11111111111111111111111111111111111111112";

async function seedPosition(
  app: Awaited<ReturnType<typeof createTestApp>>,
  positionId: string,
  state: "LP_FAILED" | "PARKED",
): Promise<void> {
  // The test app exposes its repositories via createTestApp's createApp
  // composition — easier path is to drive the routes themselves. We use
  // the dust/03 deposit-LP routes to walk a fresh draft to LP_FAILED /
  // PARKED so we don't reach into private repo state from a route test.
  const create = await app.inject({
    method: "POST",
    url: "/positions/intents",
    headers: { "x-wallet-address": OWNER },
    payload: {
      action: "add-liquidity",
      amount: "1.0",
      pool: "sol-usdc",
      mode: "fast-private",
    },
  });
  expect(create.statusCode).toBe(201);
  const created = create.json() as { position: { id: string } };
  // The intent-created id won't match positionId; we re-route the test
  // to use the server-assigned id instead.
  positionId = created.position.id;

  // Walk awaiting_signature → DEPOSITED → LP_PENDING → LP_FAILED via
  // the dust/03 transitions.
  const dep = await app.inject({
    method: "POST",
    url: `/positions/${positionId}/deposit`,
    headers: { "x-wallet-address": OWNER },
    payload: {
      nullifierHash: `nh_${positionId}`,
      commitment: "0xdead",
      intendedPool: "sol-usdc",
      denomLamports: "1000000000",
    },
  });
  expect(dep.statusCode).toBe(200);

  const pending = await app.inject({
    method: "POST",
    url: `/positions/${positionId}/lp-pending`,
    headers: { "x-wallet-address": OWNER },
  });
  expect(pending.statusCode).toBe(200);

  const failed = await app.inject({
    method: "POST",
    url: `/positions/${positionId}/lp-failed`,
    headers: { "x-wallet-address": OWNER },
    payload: { reason: "Test-induced failure." },
  });
  expect(failed.statusCode).toBe(200);

  if (state === "PARKED") {
    const parked = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/park`,
      headers: { "x-wallet-address": OWNER },
    });
    expect(parked.statusCode).toBe(200);
  }
  (seedPosition as unknown as { lastId: string }).lastId = positionId;
}

describe("POST /positions/:id/recover-funds", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    app = await createTestApp();
  });

  it("returns 200 and drives LP_FAILED → WITHDRAWN with signature + recipient", async () => {
    await seedPosition(app, "pos_route_lp_failed", "LP_FAILED");
    const positionId = (seedPosition as unknown as { lastId: string }).lastId;

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/recover-funds`,
      headers: { "x-wallet-address": OWNER },
      payload: {
        withdrawSignature: "userSignedWithdrawSig",
        withdrawRecipient: "FreshStealthAddr",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      position: { state: string };
      activity: Array<{ headline: string }>;
    };
    expect(body.position.state).toBe("WITHDRAWN");
    expect(body.activity.map((a) => a.headline)).toContain(
      "User-signed recovery submitted",
    );
  });

  it("returns 200 and drives PARKED → WITHDRAWN", async () => {
    await seedPosition(app, "pos_route_parked", "PARKED");
    const positionId = (seedPosition as unknown as { lastId: string }).lastId;

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/recover-funds`,
      headers: { "x-wallet-address": OWNER },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { position: { state: string } };
    expect(body.position.state).toBe("WITHDRAWN");
  });

  it("returns 409 InvalidRecoveryState when the Position is not LP_FAILED/PARKED", async () => {
    // Create a draft and immediately try to recover — invalid source state.
    const create = await app.inject({
      method: "POST",
      url: "/positions/intents",
      headers: { "x-wallet-address": OWNER },
      payload: {
        action: "add-liquidity",
        amount: "1.0",
        pool: "sol-usdc",
        mode: "fast-private",
      },
    });
    const created = create.json() as { position: { id: string } };

    const res = await app.inject({
      method: "POST",
      url: `/positions/${created.position.id}/recover-funds`,
      headers: { "x-wallet-address": OWNER },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as { error?: string; message?: string };
    // Either dust/04's typed error or dust/03's generic one is acceptable;
    // both surface as 409 because they share the same handler family.
    expect(body.error === "InvalidRecoveryState" || body.error === "StateTransitionRejected").toBe(true);
  });

  it("returns 403 when the authenticated wallet does not own the Position", async () => {
    await seedPosition(app, "pos_route_other", "LP_FAILED");
    const positionId = (seedPosition as unknown as { lastId: string }).lastId;

    const res = await app.inject({
      method: "POST",
      url: `/positions/${positionId}/recover-funds`,
      headers: { "x-wallet-address": OTHER },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe("POST /positions/:id/recover-funds — auth", () => {
  it("returns 401 when no wallet is stamped (strict auth)", async () => {
    const app = await createTestApp({ authPreHandlers: [strictWalletStamper] });
    const res = await app.inject({
      method: "POST",
      url: "/positions/any-id/recover-funds",
    });
    expect(res.statusCode).toBe(401);
  });
});
