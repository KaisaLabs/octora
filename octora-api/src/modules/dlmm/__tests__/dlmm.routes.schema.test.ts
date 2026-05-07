/**
 * Test plan IDs covered:
 *   API-DLM-002 (partial) listPools accepts ?network/?page/?pageSize within bounds
 *   API-DLM-003 GET /dlmm/pools/:address with too-short pubkey → 400
 *   API-DLM-008 (negative path) request validation rejects bad pageSize before service is touched
 *
 * The DLMM controller hits an external Meteora indexer / on-chain RPC, so
 * we don't try to assert successful pool data here. We only pin the JSON-
 * schema contract on the request side: bad input fails fast at 400 and
 * never reaches the service. This is the cheap layer to lock down.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "#app";
import { createMemoryRepositories } from "#test-kit/memory-db";

describe("dlmm routes — request validation", () => {
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    app = await createApp({ repos: createMemoryRepositories() });
  });

  it("API-DLM-003: GET /dlmm/pools/:address rejects too-short addresses with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/dlmm/pools/short",
    });
    expect(res.statusCode).toBe(400);
  });

  it("API-DLM-002: GET /dlmm/pools rejects pageSize > 1000 (schema bound)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/dlmm/pools?pageSize=2000",
    });
    expect(res.statusCode).toBe(400);
  });

  it("API-DLM-002: GET /dlmm/pools rejects unknown network values", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/dlmm/pools?network=testnet",
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /dlmm/pools/:address/bins rejects count below the schema floor", async () => {
    // An address of exactly the schema's minLength=32 is enough to pass the
    // params check; the request still fails on the count bound.
    const res = await app.inject({
      method: "GET",
      url: "/dlmm/pools/" + "1".repeat(32) + "/bins?count=3",
    });
    expect(res.statusCode).toBe(400);
  });
});
