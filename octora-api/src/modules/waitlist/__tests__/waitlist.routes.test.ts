/**
 * Test plan IDs covered:
 *   API-MISC-004 POST /waitlist with valid email → 201; duplicate → 409
 *   API-MISC-005 POST /waitlist with malformed email → 400
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createTestApp } from "#test-kit/route-harness";

describe("waitlist routes", () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    app = await createTestApp();
  });

  it("API-MISC-004: accepts a valid email and returns the new entry", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "user@example.com", source: "landing" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; email: string };
    expect(body.email).toBe("user@example.com");
    expect(typeof body.id).toBe("string");
  });

  it("API-MISC-004: duplicate email returns 409 (idempotent at the user-visible layer)", async () => {
    await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "twice@example.com" },
    });
    const dup = await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "twice@example.com" },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: /already/i });
  });

  it("API-MISC-005: rejects bodies missing the email field", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { source: "landing" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("API-MISC-005: rejects malformed emails via JSON-schema format=email", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/waitlist",
      payload: { email: "not-an-email" },
    });
    expect(res.statusCode).toBe(400);
  });
});
