import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "#app";
import { createMemoryRepositories } from "#test-kit/memory-db";

describe("position routes", () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    app = await createApp({ repos: createMemoryRepositories() });
  });

  it("creates a draft position intent and returns awaiting-signature state data", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/positions/intents",
      payload: {
        action: "add-liquidity",
        amount: "1.25",
        pool: "sol-usdc",
        mode: "fast-private",
      },
    });

    expect(response.statusCode).toBe(201);

    const body = response.json() as {
      intent: { state: string; positionId: string };
      position: { id: string; state: string; statusLabel: string; amountLabel: string; poolLabel: string; modeLabel: string };
      session: { state: string };
      activity: Array<{ state: string; headline: string }>;
    };

    expect(body.intent.state).toBe("draft");
    expect(body.position.state).toBe("draft");
    expect(body.position.statusLabel).toBe("Awaiting signature");
    expect(body.session.state).toBe("awaiting_signature");
    expect(body.activity[0].state).toBe("awaiting_signature");
    expect(body.activity[0].headline).toBe("Intent received");

    const readResponse = await app.inject({
      method: "GET",
      url: `/positions/${body.position.id}`,
    });

    expect(readResponse.statusCode).toBe(200);
    const readBody = readResponse.json() as typeof body;
    expect(readBody.position.id).toBe(body.position.id);
    expect(readBody.position.state).toBe("draft");
    expect(readBody.session.state).toBe("awaiting_signature");
  });

  it("returns 404 for an unknown position", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/positions/missing-position",
    });

    expect(response.statusCode).toBe(404);
  });
});
