/**
 * Phase 4 integration test layer.
 *
 * One file with happy + auth-fail + validation-fail coverage per public
 * route. Boots the full app (memory repos, no real DB, no real RPC)
 * through `createTestApp` so every plugin / preHandler / schema fires
 * exactly as it would in production.
 *
 * Test plan IDs:
 *   API-INT-001  /health responds 200
 *   API-INT-002  /metrics responds 200 with http histograms field
 *   API-INT-003  POST /waitlist: 201 happy, 400 malformed email
 *   API-INT-004  POST /positions/intents: 201 with auth header, 401 without
 *   API-INT-005  POST /positions/intents: 400 on malformed body (missing field)
 *   API-INT-006  GET  /positions/:id: 200 happy, 404 missing
 *   API-INT-007  POST /positions/:id/execute: 401 without auth
 *   API-INT-008  POST /positions/:id/claim: 401 without auth
 *   API-INT-009  POST /positions/:id/withdraw-close: 401 without auth
 *   API-INT-010  /metrics records the routes that were hit
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestApp, strictWalletStamper } from "#test-kit/route-harness";

const TEST_WALLET = "11111111111111111111111111111111";

describe("integration: full route surface", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    app = await createTestApp({ authPreHandlers: [strictWalletStamper] });
  });

  afterAll(async () => {
    await app.close();
  });

  describe("operational endpoints", () => {
    it("API-INT-001: /health returns 200", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    });

    it("API-INT-002: /metrics returns a snapshot with the http histograms field", async () => {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { http?: { routes: unknown[]; bucketsMs: unknown[] } };
      // Test harness boots without Prisma so we get the "minimal" branch,
      // but it must still include the http histograms field.
      expect(body.http).toBeDefined();
      expect(Array.isArray(body.http?.routes)).toBe(true);
      expect(Array.isArray(body.http?.bucketsMs)).toBe(true);
    });
  });

  describe("waitlist", () => {
    it("API-INT-003: 201 on a valid signup; 400 on a malformed email", async () => {
      const ok = await app.inject({
        method: "POST",
        url: "/waitlist",
        payload: { email: "integration@example.com" },
      });
      expect(ok.statusCode).toBe(201);

      const bad = await app.inject({
        method: "POST",
        url: "/waitlist",
        payload: { email: "not-an-email" },
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe("positions — auth-gated mutations", () => {
    it("API-INT-004: POST /positions/intents 201 with x-wallet-address, 401 without", async () => {
      const unauthorized = await app.inject({
        method: "POST",
        url: "/positions/intents",
        payload: {
          action: "add-liquidity",
          amount: "1.0",
          pool: "sol-usdc",
          mode: "fast-private",
        },
      });
      expect(unauthorized.statusCode).toBe(401);

      const authed = await app.inject({
        method: "POST",
        url: "/positions/intents",
        headers: { "x-wallet-address": TEST_WALLET },
        payload: {
          action: "add-liquidity",
          amount: "1.0",
          pool: "sol-usdc",
          mode: "fast-private",
        },
      });
      expect(authed.statusCode).toBe(201);
    });

    it("API-INT-005: POST /positions/intents 400 on body missing required fields", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/positions/intents",
        headers: { "x-wallet-address": TEST_WALLET },
        payload: { action: "add-liquidity" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("API-INT-006: GET /positions/:id — 200 for a known id, 404 for a missing one", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/positions/intents",
        headers: { "x-wallet-address": TEST_WALLET },
        payload: {
          action: "add-liquidity",
          amount: "0.5",
          pool: "sol-usdc",
          mode: "fast-private",
        },
      });
      const positionId = (created.json() as { position: { id: string } }).position.id;

      const ok = await app.inject({ method: "GET", url: `/positions/${positionId}` });
      expect(ok.statusCode).toBe(200);

      const missing = await app.inject({ method: "GET", url: "/positions/nope-not-a-real-id" });
      expect(missing.statusCode).toBe(404);
    });

    it("API-INT-007/008/009: mutating routes 401 without auth (with schema-valid bodies so auth runs)", async () => {
      // Schema validation runs before preHandler. Bodies below satisfy
      // each route's schema so the 401 we see is genuinely the auth gate
      // rejecting, not the body validator.
      const cases: Array<{ url: string; payload: Record<string, unknown> }> = [
        { url: "/positions/any-id/execute", payload: { signedMessage: "stub" } },
        { url: "/positions/any-id/claim", payload: {} },
        { url: "/positions/any-id/withdraw-close", payload: {} },
      ];
      for (const { url, payload } of cases) {
        const res = await app.inject({ method: "POST", url, payload });
        expect(res.statusCode).toBe(401);
      }
    });
  });

  describe("metrics: per-route histograms record activity", () => {
    it("API-INT-010: /metrics reports a cell for the most recent route hit", async () => {
      // Hit a known route, then poll /metrics and check the route shows up.
      await app.inject({ method: "GET", url: "/health" });
      const res = await app.inject({ method: "GET", url: "/metrics" });
      const body = res.json() as {
        http: { routes: Array<{ route: string; method: string; status: number; count: number }> };
      };
      const healthCell = body.http.routes.find(
        (r) => r.route === "/health" && r.method === "GET" && r.status === 200,
      );
      expect(healthCell?.count).toBeGreaterThan(0);
    });
  });
});
