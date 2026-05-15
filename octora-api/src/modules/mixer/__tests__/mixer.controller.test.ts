/**
 * Test plan IDs covered:
 *   API-MIX-001  build-deposit-tx happy path
 *   API-MIX-006  GET /mixer/deposits returns leaf-index-ordered list
 *   API-MIX-010  GET /mixer/status returns expected shape (or 404 when uninitialized)
 *   API-MIX-002  deposit with non-canonical commitment → 400
 *   API-MIX-004  deposit when pool not initialized → 400
 *   API-MIX-LP-001 GET /mixer/pools surfaces every configured Denomination
 *                  ladder bucket with its per-pool anonymitySet + threshold
 *   API-MIX-LP-002 GET /mixer/pools reports uninitialized buckets as
 *                  `{ initialized: false }` so the picker can hide them
 *
 * These tests exercise the controller against a fully mocked MixerService
 * so they don't need a Solana validator. The controller is the thinnest
 * layer in the mixer stack — its job is request parsing + status mapping
 * — so a unit test here is the cheapest place to pin those contracts.
 */
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createMixerController } from "../mixer.controller";
import {
  AnonymitySetTooThinError,
  MixerPoolNotInitializedError,
  type MixerService,
} from "../mixer.service";
import { MIN_ANONYMITY_SET } from "../anonymity";
import { ScriptedChain } from "#common/solana/scripted-chain";
import {
  MIXER_POOL_IS_PAUSED_OFFSET,
  MIXER_POOL_NEXT_LEAF_INDEX_OFFSET,
} from "../layout";

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

  describe("GET /mixer/pools (Denomination ladder)", () => {
    const PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
    const MIXER_POOL_SEED = Buffer.from("mixer_pool");
    const LADDER: bigint[] = [
      100_000_000n, // 0.1 SOL — kept empty: should appear with anonymitySet=0
      1_000_000_000n, // 1 SOL — kept healthy: should appear with anonymitySet>=MIN
      5_000_000_000n, // 5 SOL — uninitialized: should appear as { initialized: false }
      10_000_000_000n, // 10 SOL — uninitialized: same
    ];

    function poolPda(denom: bigint) {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64LE(denom);
      const [pda] = PublicKey.findProgramAddressSync(
        [MIXER_POOL_SEED, buf],
        PROGRAM_ID,
      );
      return pda;
    }

    function buildPoolAccount(nextLeafIndex: number, isPaused = false) {
      const size = MIXER_POOL_IS_PAUSED_OFFSET + 1;
      const data = Buffer.alloc(size);
      data.writeUInt32LE(nextLeafIndex, MIXER_POOL_NEXT_LEAF_INDEX_OFFSET);
      data[MIXER_POOL_IS_PAUSED_OFFSET] = isPaused ? 1 : 0;
      return {
        executable: false,
        owner: SystemProgram.programId,
        lamports: 0,
        data,
        rentEpoch: 0,
      };
    }

    async function bindWithPools(opts: {
      // Resolver returns a fake service per denom; we use it to spike the
      // anonymitySet snapshot the controller will read after the static
      // `readPoolStatus` returns the optimistic upper bound.
      services: Map<string, MixerService>;
      chain: ScriptedChain;
    }) {
      const app = Fastify({ logger: false });
      const resolver = (denom?: bigint) => {
        const key = (denom ?? LADDER[0]!).toString();
        const svc = opts.services.get(key);
        if (!svc) throw new Error(`no fake service for denom ${key}`);
        return svc;
      };
      const controller = createMixerController(resolver, {
        chain: opts.chain,
        programId: PROGRAM_ID,
        denominations: LADDER,
      });
      app.get("/mixer/pools", controller.listPools);
      return app;
    }

    it("API-MIX-LP-001: lists every configured Denomination ladder bucket with its anonymity snapshot", async () => {
      const empty01 = poolPda(LADDER[0]!);
      const healthy1 = poolPda(LADDER[1]!);
      const chain = new ScriptedChain({
        accounts: {
          // 0.1 SOL: initialized, but 0 deposits → thin
          [empty01.toBase58()]: buildPoolAccount(0),
          // 1 SOL: initialized with MIN unspent deposits → strong
          [healthy1.toBase58()]: buildPoolAccount(MIN_ANONYMITY_SET),
          // 5 SOL + 10 SOL: missing on-chain accounts → null
        },
        balances: {
          [empty01.toBase58()]: 0,
          [healthy1.toBase58()]: Number(LADDER[1]!) * MIN_ANONYMITY_SET,
        },
      });

      const services = new Map<string, MixerService>();
      services.set(LADDER[0]!.toString(), fakeService({
        getAnonymitySetSnapshot: vi.fn(async () => ({
          nextLeafIndex: 0,
          withdrawalCount: 0,
          anonymitySet: 0,
        })),
      } as Partial<MixerService>));
      services.set(LADDER[1]!.toString(), fakeService({
        getAnonymitySetSnapshot: vi.fn(async () => ({
          nextLeafIndex: MIN_ANONYMITY_SET,
          withdrawalCount: 0,
          anonymitySet: MIN_ANONYMITY_SET,
        })),
      } as Partial<MixerService>));
      // 5 + 10 SOL: never resolved (their pools are uninitialized — the
      // controller short-circuits with `{ initialized: false }` before
      // calling the resolver). Leave them out of the map to lock that in.

      const app = await bindWithPools({ services, chain });
      const res = await app.inject({ method: "GET", url: "/mixer/pools" });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.anonymitySetMin).toBe(MIN_ANONYMITY_SET);
      expect(body.pools).toHaveLength(4);

      const byDenom = new Map<string, any>(
        body.pools.map((p: any) => [p.denomination, p]),
      );

      // 0.1 SOL — initialized, anonymitySet under threshold (the picker
      // will disable this with a "needs N more deposits" tooltip).
      const thin = byDenom.get(LADDER[0]!.toString());
      expect(thin.initialized).toBe(true);
      expect(thin.anonymitySet).toBe(0);
      expect(thin.anonymitySetMin).toBe(MIN_ANONYMITY_SET);
      expect(thin.isPaused).toBe(false);

      // 1 SOL — initialized, anonymitySet at threshold (picker enables it).
      const strong = byDenom.get(LADDER[1]!.toString());
      expect(strong.initialized).toBe(true);
      expect(strong.anonymitySet).toBe(MIN_ANONYMITY_SET);
      expect(strong.anonymitySetMin).toBe(MIN_ANONYMITY_SET);

      // 5 SOL + 10 SOL — uninitialized.
      expect(byDenom.get(LADDER[2]!.toString())).toEqual({
        denomination: LADDER[2]!.toString(),
        initialized: false,
      });
      expect(byDenom.get(LADDER[3]!.toString())).toEqual({
        denomination: LADDER[3]!.toString(),
        initialized: false,
      });

      await app.close();
    });

    it("API-MIX-LP-002: filtering caller — pools below MIN_ANONYMITY_SET are flagged but still listed (picker decides)", async () => {
      // The API does *not* filter sub-threshold pools out of /mixer/pools
      // — it surfaces every bucket with `anonymitySet` so the picker can
      // show them disabled-with-tooltip (per memory `feedback_truthful_ui`).
      // This test asserts that contract so a future refactor doesn't
      // accidentally hide sub-threshold pools and break the picker's UX.
      const empty01 = poolPda(LADDER[0]!);
      const chain = new ScriptedChain({
        accounts: { [empty01.toBase58()]: buildPoolAccount(0) },
      });
      const services = new Map<string, MixerService>();
      services.set(LADDER[0]!.toString(), fakeService({
        getAnonymitySetSnapshot: vi.fn(async () => ({
          nextLeafIndex: 0,
          withdrawalCount: 0,
          anonymitySet: 0,
        })),
      } as Partial<MixerService>));

      const app = await bindWithPools({ services, chain });
      const res = await app.inject({ method: "GET", url: "/mixer/pools" });
      const body = res.json();

      const thin = body.pools.find(
        (p: any) => p.denomination === LADDER[0]!.toString(),
      );
      expect(thin).toBeDefined();
      expect(thin.initialized).toBe(true);
      expect(thin.anonymitySet).toBeLessThan(body.anonymitySetMin);

      await app.close();
    });
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
