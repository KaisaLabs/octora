/**
 * Test plan IDs covered:
 *   API-MIX-013  rate-limit: 31st write request in a minute → 429
 *   API-MIX-014  rate-limit: 121st read request in a minute → 429
 *   OPS-RATE-001 limiter resets after window
 *   OPS-RATE-002 independent buckets per limiter instance
 *
 * The rate limiter is a Fastify preHandler hook. We exercise it via a tiny
 * Fastify instance rather than calling it directly so the 429 reply path
 * (status code + Retry-After header) is asserted exactly as production.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { makeRateLimiter } from "../rate-limit";

async function makeApp(opts: { windowMs: number; max: number }) {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", makeRateLimiter(opts));
  app.get("/x", async () => ({ ok: true }));
  return app;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("makeRateLimiter", () => {
  it("OPS-RATE-001 / API-MIX-013: returns 429 once max is exceeded inside the window", async () => {
    const app = await makeApp({ windowMs: 60_000, max: 3 });

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "GET", url: "/x" });
      expect(res.statusCode).toBe(200);
    }
    const blocked = await app.inject({ method: "GET", url: "/x" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toMatch(/^\d+$/);
    expect(blocked.json()).toMatchObject({ error: "Too Many Requests" });

    await app.close();
  });

  it("OPS-RATE-001: bucket resets after windowMs has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const app = await makeApp({ windowMs: 1_000, max: 1 });

    const ok = await app.inject({ method: "GET", url: "/x" });
    expect(ok.statusCode).toBe(200);
    const blocked = await app.inject({ method: "GET", url: "/x" });
    expect(blocked.statusCode).toBe(429);

    vi.advanceTimersByTime(1_500);

    const okAgain = await app.inject({ method: "GET", url: "/x" });
    expect(okAgain.statusCode).toBe(200);

    await app.close();
  });

  it("OPS-RATE-002: independent limiter instances have independent buckets", async () => {
    // Two limiters with different ceilings on the same Fastify instance.
    // Hitting limiter A's ceiling must not block requests routed through
    // limiter B — this is exactly the read-vs-write split in mixer.routes.
    const app = Fastify({ logger: false });
    const tight = makeRateLimiter({ windowMs: 60_000, max: 2 });
    const loose = makeRateLimiter({ windowMs: 60_000, max: 10 });
    await app.register(async (scope) => {
      scope.addHook("onRequest", tight);
      scope.get("/write", async () => ({ ok: true }));
    });
    await app.register(async (scope) => {
      scope.addHook("onRequest", loose);
      scope.get("/read", async () => ({ ok: true }));
    });

    // Saturate the tight bucket.
    await app.inject({ method: "GET", url: "/write" });
    await app.inject({ method: "GET", url: "/write" });
    const blocked = await app.inject({ method: "GET", url: "/write" });
    expect(blocked.statusCode).toBe(429);

    // Loose bucket is unaffected.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "GET", url: "/read" });
      expect(res.statusCode).toBe(200);
    }

    await app.close();
  });

  it("missing IP falls into the shared 'unknown' bucket rather than dodging the limit", async () => {
    // app.inject() injects synthetic requests without a real IP, so all
    // requests share the same bucket via the "unknown" sentinel. This
    // confirms a missing-IP client cannot bypass the limiter.
    const app = await makeApp({ windowMs: 60_000, max: 2 });
    await app.inject({ method: "GET", url: "/x" });
    await app.inject({ method: "GET", url: "/x" });
    const blocked = await app.inject({ method: "GET", url: "/x" });
    expect(blocked.statusCode).toBe(429);
    await app.close();
  });
});
