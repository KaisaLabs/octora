/**
 * Test plan IDs covered:
 *   API-MIX-001  build-deposit-tx happy path
 *   API-MIX-006  GET /mixer/deposits returns leaf-index-ordered list
 *   API-MIX-010  GET /mixer/status returns expected shape (or 404 when uninitialized)
 *   API-MIX-002  deposit with non-canonical commitment → 400
 *   API-MIX-004  deposit when pool not initialized → 400
 *
 * These tests exercise the controller against a fully mocked MixerService
 * so they don't need a Solana validator. The controller is the thinnest
 * layer in the mixer stack — its job is request parsing + status mapping
 * — so a unit test here is the cheapest place to pin those contracts.
 */
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { createMixerController } from "../mixer.controller";
import {
  AnonymitySetTooThinError,
  MixerPoolNotInitializedError,
  type MixerService,
} from "../mixer.service";

function fakeService(over: Partial<MixerService> = {}): MixerService {
  // Cast: we only need the methods the controller calls.
  return {
    getPoolStatus: vi.fn(async () => null),
    listDeposits: vi.fn(() => []),
    buildDepositTransaction: vi.fn(async () => ({ transaction: "base64-tx" })),
    buildWithdrawTransaction: vi.fn(async () => ({ transaction: "base64-tx" })),
    buildInitializeTransaction: vi.fn(async () => ({
      transaction: "base64-init",
      poolAddress: "Pool1111111111111111111111111111111111111111",
    })),
    recordDeposit: vi.fn(),
    ...over,
  } as unknown as MixerService;
}

async function bindController(service: MixerService) {
  const app = Fastify({ logger: false });
  // Resolver pattern: tests don't care about denomination dispatch, so the
  // resolver returns the same fake service regardless of what the controller
  // asks for.
  const controller = createMixerController(() => service);
  app.get("/mixer/status", controller.getStatus);
  app.get("/mixer/deposits", controller.listDeposits);
  app.post("/mixer/deposit", controller.deposit);
  app.post("/mixer/confirm-deposit", controller.confirmDeposit);
  app.post("/mixer/withdraw", controller.withdraw);
  app.post("/mixer/initialize", controller.initialize);
  return app;
}

describe("mixer controller", () => {
  it("API-MIX-010 (positive): GET /mixer/status returns the service status payload", async () => {
    const status = {
      poolAddress: "Pool1111111111111111111111111111111111111111",
      denomination: "1000000000",
      nextLeafIndex: 7,
      isPaused: false,
      balance: "7000000000",
      depositsTracked: 7,
    };
    const service = fakeService({
      getPoolStatus: vi.fn(async () => status),
    } as Partial<MixerService>);
    const app = await bindController(service);

    const res = await app.inject({ method: "GET", url: "/mixer/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(status);

    await app.close();
  });

  it("API-MIX-010 (uninit): GET /mixer/status returns 404 when service yields null", async () => {
    const app = await bindController(fakeService());
    const res = await app.inject({ method: "GET", url: "/mixer/status" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: /not initialized/i });
    await app.close();
  });

  it("API-MIX-006: GET /mixer/deposits returns whatever listDeposits() yields", async () => {
    const deposits = [
      { commitment: "1", leafIndex: 0, txSignature: "sig0" },
      { commitment: "2", leafIndex: 1, txSignature: "sig1" },
    ];
    const service = fakeService({
      listDeposits: vi.fn(() => deposits),
    } as Partial<MixerService>);
    const app = await bindController(service);

    const res = await app.inject({ method: "GET", url: "/mixer/deposits" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deposits });

    await app.close();
  });

  it("API-MIX-001: POST /mixer/deposit forwards depositor + commitment and returns the unsigned tx", async () => {
    const build = vi.fn(async () => ({ transaction: "base64-deposit" }));
    const service = fakeService({
      buildDepositTransaction: build,
    } as Partial<MixerService>);
    const app = await bindController(service);

    const res = await app.inject({
      method: "POST",
      url: "/mixer/deposit",
      payload: {
        depositor: "Dep11111111111111111111111111111111111111111",
        commitment: "12345678901234567890",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ transaction: "base64-deposit" });
    expect(build).toHaveBeenCalledWith({
      depositorPubkey: "Dep11111111111111111111111111111111111111111",
      commitment: 12345678901234567890n,
    });

    await app.close();
  });

  it("API-MIX-004: POST /mixer/deposit returns 400 when pool isn't initialized on-chain", async () => {
    const service = fakeService({
      buildDepositTransaction: vi.fn(async () => {
        throw new MixerPoolNotInitializedError(1_000_000_000n, "Pool1111");
      }),
    } as Partial<MixerService>);
    const app = await bindController(service);

    const res = await app.inject({
      method: "POST",
      url: "/mixer/deposit",
      payload: {
        depositor: "Dep11111111111111111111111111111111111111111",
        commitment: "1",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not initialized/i);

    await app.close();
  });

  it("API-MIX-002 (boundary): POST /mixer/deposit with non-numeric commitment surfaces 400", async () => {
    // BigInt("not-a-number") throws SyntaxError. The controller catches and
    // turns it into a 400 — verifying the controller doesn't leak a 500.
    const app = await bindController(fakeService());
    const res = await app.inject({
      method: "POST",
      url: "/mixer/deposit",
      payload: {
        depositor: "Dep11111111111111111111111111111111111111111",
        commitment: "not-a-number",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/cannot convert|invalid|not.+number/i);

    await app.close();
  });

  it("POST /mixer/withdraw returns 400 ANONYMITY_SET_TOO_THIN when the gate trips", async () => {
    const service = fakeService({
      buildWithdrawTransaction: vi.fn(async () => {
        throw new AnonymitySetTooThinError(3, 20, 1_000_000_000n);
      }),
    } as Partial<MixerService>);
    const app = await bindController(service);

    const res = await app.inject({
      method: "POST",
      url: "/mixer/withdraw",
      payload: {
        signer: "Dep11111111111111111111111111111111111111111",
        recipient: "Rec11111111111111111111111111111111111111111",
        proofBytes: "AAAA",
        publicInputsBytes: "AAAA",
        nullifierHash: "1",
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("ANONYMITY_SET_TOO_THIN");
    expect(body.current).toBe(3);
    expect(body.required).toBe(20);
    expect(body.denomination).toBe("1000000000");

    await app.close();
  });

  it("POST /mixer/confirm-deposit calls recordDeposit and returns ok=true", async () => {
    const recordDeposit = vi.fn();
    const service = fakeService({
      recordDeposit,
    } as Partial<MixerService>);
    const app = await bindController(service);

    const res = await app.inject({
      method: "POST",
      url: "/mixer/confirm-deposit",
      payload: { commitment: "42", leafIndex: 3, txSignature: "sigX" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(recordDeposit).toHaveBeenCalledWith(42n, 3, "sigX");

    await app.close();
  });
});
