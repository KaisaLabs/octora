/**
 * Test plan IDs covered:
 *   OPS-RATE-003 memory factory: independent buckets per `prefix`
 *   OPS-RATE-004 hook: 429 carries Retry-After in seconds
 *   OPS-RATE-005 walletThenIpKey: wallet wins over IP when both present
 *   OPS-RATE-006 walletThenIpKey: falls back to IP when wallet missing
 *   OPS-RATE-007 hook: rotating IP cannot dodge a wallet-keyed bucket
 */
import Fastify, { type FastifyRequest, type preHandlerHookHandler } from "fastify";
import { describe, expect, it } from "vitest";

import {
  createMemoryRateLimiterFactory,
  rateLimitHook,
  walletThenIpKey,
} from "../index.js";

describe("memory rate-limiter factory", () => {
  it("OPS-RATE-003: independent prefixes keep independent buckets", async () => {
    const factory = createMemoryRateLimiterFactory();
    const tight = factory.create({ windowMs: 60_000, max: 2, prefix: "a" });
    const loose = factory.create({ windowMs: 60_000, max: 10, prefix: "b" });

    await tight.consume("x");
    await tight.consume("x");
    const blocked = await tight.consume("x");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    // Loose limiter shares no state with tight.
    for (let i = 0; i < 5; i++) {
      const r = await loose.consume("x");
      expect(r.allowed).toBe(true);
    }
    await factory.close();
  });
});

describe("rateLimitHook", () => {
  async function makeApp(
    keyFor?: (req: FastifyRequest) => string,
    stamp?: preHandlerHookHandler,
  ) {
    const factory = createMemoryRateLimiterFactory();
    const hook = rateLimitHook(factory, {
      windowMs: 60_000,
      max: 2,
      prefix: "test",
      keyFor,
    });
    const app = Fastify({ logger: false });
    if (stamp) app.addHook("preHandler", stamp);
    app.addHook("preHandler", hook);
    app.get("/x", async () => ({ ok: true }));
    return { app, factory };
  }

  it("OPS-RATE-004: 429 response carries an integer Retry-After header", async () => {
    const { app, factory } = await makeApp();
    await app.inject({ method: "GET", url: "/x" });
    await app.inject({ method: "GET", url: "/x" });
    const blocked = await app.inject({ method: "GET", url: "/x" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toMatch(/^\d+$/);
    expect(blocked.json()).toMatchObject({ error: "Too Many Requests" });
    await app.close();
    await factory.close();
  });

  it("OPS-RATE-005: walletThenIpKey buckets two IPs into one wallet quota", async () => {
    // Stamp `req.wallet` from a header so we can simulate authenticated
    // calls without dragging the real wallet-signature pipeline into a
    // limiter test.
    const stamp: preHandlerHookHandler = async (req) => {
      const w = req.headers["x-test-wallet"];
      if (typeof w === "string") {
        // Use any 32-char base58 string the PublicKey ctor accepts; for
        // limiter tests the value just needs to be present and stable.
        req.wallet = {
          address: w,
          // The limiter only reads `.address`, so the PublicKey is dummy.
          pubkey: undefined as unknown as import("@solana/web3.js").PublicKey,
        };
      }
    };
    const { app, factory } = await makeApp(walletThenIpKey, stamp);

    // Two distinct IPs (`x-forwarded-for`) with the same wallet header
    // share one bucket — third call is blocked.
    const wallet = "wallet-A";
    const r1 = await app.inject({
      method: "GET",
      url: "/x",
      headers: { "x-test-wallet": wallet, "x-forwarded-for": "1.1.1.1" },
    });
    const r2 = await app.inject({
      method: "GET",
      url: "/x",
      headers: { "x-test-wallet": wallet, "x-forwarded-for": "2.2.2.2" },
    });
    const r3 = await app.inject({
      method: "GET",
      url: "/x",
      headers: { "x-test-wallet": wallet, "x-forwarded-for": "3.3.3.3" },
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429);
    await app.close();
    await factory.close();
  });

  it("OPS-RATE-006: walletThenIpKey falls back to IP when no wallet present", async () => {
    const { app, factory } = await makeApp(walletThenIpKey);
    // No wallet stamper, so every call falls into the synthetic-ip bucket.
    await app.inject({ method: "GET", url: "/x" });
    await app.inject({ method: "GET", url: "/x" });
    const blocked = await app.inject({ method: "GET", url: "/x" });
    expect(blocked.statusCode).toBe(429);
    await app.close();
    await factory.close();
  });
});
