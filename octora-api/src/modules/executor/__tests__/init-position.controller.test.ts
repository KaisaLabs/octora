/**
 * Locks the privacy invariant from CORE_FEATURES_MVP_PLAN §0.5:
 * `exit_recipient` on `dlmm_init_position` MUST always be the stealth wallet,
 * never the user's main wallet. If a future caller passes an override in the
 * request body, the controller is required to ignore it and force the stealth
 * pubkey through to `executor.buildInitPositionTx`.
 */
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createExecutorController } from "../executor.controller";
import type { ExecutorService } from "../executor.service";

type BuildInitPositionSpy = ReturnType<typeof vi.fn<(args: {
  stealth: PublicKey;
  lbPair: PublicKey;
  exitRecipient: PublicKey;
  lowerBinId: number;
  width: number;
}) => Promise<{ transaction: string }>>>;

function fakeExecutor(spy: BuildInitPositionSpy): ExecutorService {
  return {
    buildInitPositionTx: spy,
  } as unknown as ExecutorService;
}

async function bindController(executor: ExecutorService) {
  const app = Fastify({ logger: false });
  const controller = createExecutorController(executor);
  app.post("/executor/init-position-tx", controller.initPositionTx);
  return app;
}

const STEALTH = Keypair.generate().publicKey.toBase58();
const MAIN_WALLET = Keypair.generate().publicKey.toBase58();
const LB_PAIR = Keypair.generate().publicKey.toBase58();

describe("executor controller — exit_recipient invariant", () => {
  it("forces exit_recipient = stealth when the caller omits it", async () => {
    const spy: BuildInitPositionSpy = vi.fn(async () => ({ transaction: "base64-tx" }));
    const app = await bindController(fakeExecutor(spy));

    const res = await app.inject({
      method: "POST",
      url: "/executor/init-position-tx",
      payload: { stealth: STEALTH, lbPair: LB_PAIR, lowerBinId: 100, width: 10 },
    });

    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0]![0];
    expect(args.exitRecipient.toBase58()).toBe(STEALTH);
    expect(args.stealth.toBase58()).toBe(STEALTH);

    await app.close();
  });

  it("ignores a caller-supplied exit_recipient and substitutes stealth", async () => {
    // This is the privacy gate: even if the client tries to redirect proceeds
    // to the main wallet (which would publicly link main ↔ stealth via every
    // future claim_fees / withdraw_close), the controller must override.
    const spy: BuildInitPositionSpy = vi.fn(async () => ({ transaction: "base64-tx" }));
    const app = await bindController(fakeExecutor(spy));

    const res = await app.inject({
      method: "POST",
      url: "/executor/init-position-tx",
      payload: {
        stealth: STEALTH,
        lbPair: LB_PAIR,
        lowerBinId: 100,
        width: 10,
        exitRecipient: MAIN_WALLET,
      },
    });

    expect(res.statusCode).toBe(200);
    const args = spy.mock.calls[0]![0];
    expect(args.exitRecipient.toBase58()).toBe(STEALTH);
    expect(args.exitRecipient.toBase58()).not.toBe(MAIN_WALLET);

    await app.close();
  });
});
