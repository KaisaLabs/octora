import type { FastifyReply, FastifyRequest } from "fastify";
import { PublicKey } from "@solana/web3.js";
import type { ExecutorService, TestPairConfig } from "./executor.service.js";

export function createExecutorController(executor: ExecutorService) {
  return {
    /** POST /executor/setup-pair — server creates mints + LB pair + bin arrays. */
    async setupPair(_req: FastifyRequest, reply: FastifyReply) {
      const config = await executor.setupTestPair();
      return reply.send(config);
    },

    /** POST /executor/mint-tokens — body: { owner, tokenX, tokenY, amountX, amountY } */
    async mintTokens(
      req: FastifyRequest<{
        Body: { owner: string; tokenX: string; tokenY: string; amountX: string; amountY: string };
      }>,
      reply: FastifyReply,
    ) {
      const { owner, tokenX, tokenY, amountX, amountY } = req.body;
      const result = await executor.mintTestTokens({
        owner: new PublicKey(owner),
        tokenX: new PublicKey(tokenX),
        tokenY: new PublicKey(tokenY),
        amountX: BigInt(amountX),
        amountY: BigInt(amountY),
      });
      return reply.send(result);
    },

    /** POST /executor/init-position-tx */
    async initPositionTx(
      req: FastifyRequest<{
        Body: {
          stealth: string;
          lbPair: string;
          exitRecipient: string;
          lowerBinId: number;
          width: number;
        };
      }>,
      reply: FastifyReply,
    ) {
      const { stealth, lbPair, exitRecipient, lowerBinId, width } = req.body;
      const result = await executor.buildInitPositionTx({
        stealth: new PublicKey(stealth),
        lbPair: new PublicKey(lbPair),
        exitRecipient: new PublicKey(exitRecipient),
        lowerBinId,
        width,
      });
      return reply.send(result);
    },

    /** POST /executor/add-liquidity-tx */
    async addLiquidityTx(
      req: FastifyRequest<{
        Body: {
          stealth: string;
          userOwner: string;
          config: TestPairConfig;
          amountX: string;
          amountY: string;
        };
      }>,
      reply: FastifyReply,
    ) {
      const { stealth, userOwner, config, amountX, amountY } = req.body;
      const result = await executor.buildAddLiquidityTx({
        stealth: new PublicKey(stealth),
        userOwner: new PublicKey(userOwner),
        config,
        amountX: BigInt(amountX),
        amountY: BigInt(amountY),
      });
      return reply.send(result);
    },

    /** POST /executor/withdraw-close-tx */
    async withdrawCloseTx(
      req: FastifyRequest<{
        Body: { stealth: string; exitRecipient: string; config: TestPairConfig };
      }>,
      reply: FastifyReply,
    ) {
      const { stealth, exitRecipient, config } = req.body;
      const result = await executor.buildWithdrawCloseTx({
        stealth: new PublicKey(stealth),
        exitRecipient: new PublicKey(exitRecipient),
        config,
      });
      return reply.send(result);
    },

    /** GET /executor/position-authority?stealth=... */
    async positionAuthority(
      req: FastifyRequest<{ Querystring: { stealth: string } }>,
      reply: FastifyReply,
    ) {
      const result = await executor.fetchPositionAuthority(new PublicKey(req.query.stealth));
      if (!result) return reply.status(404).send({ error: "PositionAuthority not initialised" });
      return reply.send(result);
    },

    /**
     * GET /executor/devnet-pools — proxies Meteora's devnet pool index so
     * the browser can populate a "pick a pool" dropdown without dragging
     * the SDK into the bundle. Returns a slimmed list (address, name,
     * mints, bin_step, current_price, reserves) so payloads stay small.
     */
    async devnetPools(_req: FastifyRequest, reply: FastifyReply) {
      const res = await fetch("https://dlmm-api.devnet.meteora.ag/pair/all");
      if (!res.ok) {
        return reply.status(502).send({ error: `Meteora devnet API ${res.status}` });
      }
      const all = (await res.json()) as Array<Record<string, unknown>>;
      const slim = all.map((p) => ({
        address: p.address,
        name: p.name,
        mintX: p.mint_x,
        mintY: p.mint_y,
        binStep: p.bin_step,
        currentPrice: p.current_price,
        reserveXAmount: p.reserve_x_amount,
        reserveYAmount: p.reserve_y_amount,
        liquidity: p.liquidity,
        isVerified: p.is_verified,
      }));
      return reply.send({ pools: slim });
    },

    /** POST /executor/use-pool — body: { lbPair, width? } */
    async usePool(
      req: FastifyRequest<{ Body: { lbPair: string; width?: number } }>,
      reply: FastifyReply,
    ) {
      try {
        const config = await executor.useExistingPool({
          lbPair: new PublicKey(req.body.lbPair),
          width: req.body.width,
        });
        return reply.send(config);
      } catch (err) {
        return reply
          .status(400)
          .send({ error: err instanceof Error ? err.message : "use-pool failed" });
      }
    },
  };
}
