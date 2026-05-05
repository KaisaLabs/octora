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
  };
}
