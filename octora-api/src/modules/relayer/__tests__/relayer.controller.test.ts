/**
 * Test plan IDs covered:
 *   API-RLY-001  GET /relayer/info returns advertised pubkey + fee + denomination
 *   API-RLY-004  POST /relayer/withdraw rejects body whose `fee` ≠ advertised fee
 *   API-RLY-009  POST /relayer/withdraw rejects malformed proof / missing fields
 *   OPS-SEC-006  schema-shape errors don't leak internal stack traces
 *
 * Controller-level test (not full app) — the actual RelayerService construction
 * reads a keypair file and opens an RPC connection at boot, both of which we
 * deliberately avoid here. The controller is the right layer to pin the
 * advertised-fee binding (which is a *security* invariant, not just UX).
 */
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  createRelayerController,
  type RelayerInfoResponse,
} from "../relayer.controller";
import type { RelayerService } from "../relayer.service";

const ADVERTISED_INFO: RelayerInfoResponse = {
  relayerPubkey: "Re1111111111111111111111111111111111111111",
  feeLamports: "1000000",
  denominationLamports: "1000000000",
  mixerPoolAddress: "Pool1111111111111111111111111111111111111111",
};

function fakeService(over: Partial<RelayerService> = {}): RelayerService {
  return {
    processWithdrawal: vi.fn(async () => ({
      success: true,
      txSignature: "sig",
      recipient: "Rec1111111111111111111111111111111111111111",
      amountLamports: "999000000",
      feeLamports: "1000000",
      error: undefined,
    })),
    ...over,
  } as unknown as RelayerService;
}

async function bindController(service: RelayerService) {
  const app = Fastify({ logger: false });
  // Resolver pattern: tests dispatch every request to the same fake service
  // regardless of denomination. Production wiring routes via RelayerRegistry.
  const controller = createRelayerController(
    () => ({ service, info: ADVERTISED_INFO }),
    ADVERTISED_INFO,
  );
  app.get("/relayer/info", controller.getInfo);
  app.post("/relayer/withdraw", controller.withdraw);
  return app;
}

const VALID_BODY = {
  proof: { pi_a: ["0", "0"], pi_b: [["0", "0"]], pi_c: ["0", "0"] },
  publicSignals: ["0", "0", "0", "0", "0"],
  root: "0",
  nullifierHash: "0",
  recipient: "Rec1111111111111111111111111111111111111111",
  fee: ADVERTISED_INFO.feeLamports,
};

describe("relayer controller", () => {
  it("API-RLY-001: GET /relayer/info echoes the configured info bundle", async () => {
    const app = await bindController(fakeService());
    const res = await app.inject({ method: "GET", url: "/relayer/info" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ADVERTISED_INFO);
    await app.close();
  });

  it("API-RLY-009: missing publicSignals → 400 with stable error shape, never invokes service", async () => {
    const processWithdrawal = vi.fn();
    const app = await bindController(
      fakeService({ processWithdrawal } as Partial<RelayerService>),
    );

    const res = await app.inject({
      method: "POST",
      url: "/relayer/withdraw",
      payload: { ...VALID_BODY, publicSignals: undefined },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: /publicSignals/ });
    expect(processWithdrawal).not.toHaveBeenCalled();

    await app.close();
  });

  it("API-RLY-009: publicSignals length must be exactly 5", async () => {
    const processWithdrawal = vi.fn();
    const app = await bindController(
      fakeService({ processWithdrawal } as Partial<RelayerService>),
    );

    const res = await app.inject({
      method: "POST",
      url: "/relayer/withdraw",
      payload: { ...VALID_BODY, publicSignals: ["0", "0", "0"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/array of 5/);
    expect(processWithdrawal).not.toHaveBeenCalled();

    await app.close();
  });

  it("API-RLY-004: fee in body must equal advertised relayer fee", async () => {
    // This is a security check: a client trying to bind a 0-fee withdrawal
    // public input must be rejected before the proof is even submitted.
    const processWithdrawal = vi.fn();
    const app = await bindController(
      fakeService({ processWithdrawal } as Partial<RelayerService>),
    );

    const res = await app.inject({
      method: "POST",
      url: "/relayer/withdraw",
      payload: { ...VALID_BODY, fee: "0" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/advertised relayer fee/);
    expect(processWithdrawal).not.toHaveBeenCalled();

    await app.close();
  });

  it("API-RLY-009: recipient must be a valid Solana address", async () => {
    const processWithdrawal = vi.fn();
    const app = await bindController(
      fakeService({ processWithdrawal } as Partial<RelayerService>),
    );

    const res = await app.inject({
      method: "POST",
      url: "/relayer/withdraw",
      payload: { ...VALID_BODY, recipient: "not-a-pubkey" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/valid Solana address/);
    expect(processWithdrawal).not.toHaveBeenCalled();

    await app.close();
  });

  it("API-RLY-002 (positive): valid body forwards to the service and echoes its result", async () => {
    const processWithdrawal = vi.fn(async () => ({
      success: true,
      txSignature: "sig-OK",
      nullifierHash: VALID_BODY.nullifierHash,
      recipient: VALID_BODY.recipient,
      amountLamports: "999000000",
      feeLamports: ADVERTISED_INFO.feeLamports,
      error: undefined,
    }));
    const app = await bindController(
      fakeService({ processWithdrawal } as Partial<RelayerService>),
    );

    const res = await app.inject({
      method: "POST",
      url: "/relayer/withdraw",
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      txSignature: "sig-OK",
      feeLamports: ADVERTISED_INFO.feeLamports,
    });
    expect(processWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: VALID_BODY.recipient,
        relayer: ADVERTISED_INFO.relayerPubkey,
        fee: ADVERTISED_INFO.feeLamports,
      }),
    );

    await app.close();
  });

  it("when the service reports failure, controller returns 400 with the error message", async () => {
    const processWithdrawal = vi.fn(async () => ({
      success: false,
      txSignature: null,
      nullifierHash: VALID_BODY.nullifierHash,
      recipient: VALID_BODY.recipient,
      amountLamports: "0",
      feeLamports: ADVERTISED_INFO.feeLamports,
      error: "nullifier already spent",
    }));
    const app = await bindController(
      fakeService({ processWithdrawal } as Partial<RelayerService>),
    );

    const res = await app.inject({
      method: "POST",
      url: "/relayer/withdraw",
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      success: false,
      error: "nullifier already spent",
    });

    await app.close();
  });
});
