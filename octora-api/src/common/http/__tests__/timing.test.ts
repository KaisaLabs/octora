/**
 * Test plan IDs covered:
 *   API-MISC-006 (new) histogram registry buckets observations correctly
 *   API-MISC-007 (new) onRequest/onResponse hooks record per matched route
 *   API-MISC-008 (new) unmatched URLs collapse into a single `unknown` cell
 */
import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import { createHttpTimingRegistry, registerHttpTiming } from "../timing";

describe("http timing registry", () => {
  it("API-MISC-006: cumulative buckets count durations at or under the bound", () => {
    const reg = createHttpTimingRegistry();
    reg.record({ route: "/foo", method: "GET", status: 200, durationMs: 7 });
    reg.record({ route: "/foo", method: "GET", status: 200, durationMs: 80 });
    reg.record({ route: "/foo", method: "GET", status: 200, durationMs: 800 });

    const snap = reg.snapshot();
    expect(snap.routes).toHaveLength(1);
    const cell = snap.routes[0]!;
    expect(cell.count).toBe(3);
    expect(cell.sumMs).toBe(887);

    // Bucket bounds: 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000.
    // 7ms hits le>=10; 80ms hits le>=100; 800ms hits le>=1000.
    const le = Object.fromEntries(cell.buckets.map((b) => [b.leMs, b.count]));
    expect(le[5]).toBe(0);
    expect(le[10]).toBe(1);
    expect(le[25]).toBe(1);
    expect(le[50]).toBe(1);
    expect(le[100]).toBe(2);
    expect(le[250]).toBe(2);
    expect(le[500]).toBe(2);
    expect(le[1000]).toBe(3);
    expect(le[10_000]).toBe(3);
  });

  it("API-MISC-006: separates cells by route, method, and status", () => {
    const reg = createHttpTimingRegistry();
    reg.record({ route: "/a", method: "GET", status: 200, durationMs: 1 });
    reg.record({ route: "/a", method: "GET", status: 500, durationMs: 1 });
    reg.record({ route: "/a", method: "POST", status: 200, durationMs: 1 });
    reg.record({ route: "/b", method: "GET", status: 200, durationMs: 1 });

    expect(reg.snapshot().routes).toHaveLength(4);
  });

  it("reset() clears all cells", () => {
    const reg = createHttpTimingRegistry();
    reg.record({ route: "/a", method: "GET", status: 200, durationMs: 1 });
    reg.reset();
    expect(reg.snapshot().routes).toHaveLength(0);
  });
});

describe("http timing plugin", () => {
  it("API-MISC-007: records the matched route pattern, not the request URL", async () => {
    const reg = createHttpTimingRegistry();
    const app = Fastify({ logger: false });
    registerHttpTiming(app, reg);
    app.get("/items/:id", async () => ({ ok: true }));

    await app.inject({ method: "GET", url: "/items/abc" });
    await app.inject({ method: "GET", url: "/items/xyz" });
    await app.close();

    const snap = reg.snapshot();
    expect(snap.routes).toHaveLength(1);
    expect(snap.routes[0]?.route).toBe("/items/:id");
    expect(snap.routes[0]?.count).toBe(2);
  });

  it("API-MISC-008: unmatched URLs collapse into one `unknown` cell instead of unique buckets", async () => {
    const reg = createHttpTimingRegistry();
    const app = Fastify({ logger: false });
    registerHttpTiming(app, reg);

    await app.inject({ method: "GET", url: "/missing-1" });
    await app.inject({ method: "GET", url: "/missing-2" });
    await app.close();

    const unknown = reg.snapshot().routes.filter((r) => r.route === "unknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.count).toBe(2);
    expect(unknown[0]?.status).toBe(404);
  });
});
