import type { FastifyReply, FastifyRequest } from "fastify";
import { PublicKey } from "@solana/web3.js";
import type { ExecutorService, TestPairConfig } from "./executor.service.js";

export function createExecutorController(executor: ExecutorService) {
  return {
    /**
     * POST /executor/setup-pair — server creates mints + LB pair + bin arrays.
     * Optional body: { useNativeSol?: boolean, lowerBinId?: number, width?: number }
     */
    async setupPair(
      req: FastifyRequest<{ Body?: { useNativeSol?: boolean; lowerBinId?: number; width?: number } }>,
      reply: FastifyReply,
    ) {
      const config = await executor.setupTestPair(req.body ?? {});
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

    /**
     * POST /executor/init-position-tx
     *
     * `exit_recipient` is intentionally ignored if the caller supplies one —
     * the privacy invariant from CORE_FEATURES_MVP_PLAN §0.5 requires that
     * every claim_fees / withdraw_close routes proceeds to the stealth ATA,
     * never directly to the main wallet. The PoolAuthority PDA stores this
     * value at init time and downstream instructions read from it, so a
     * client-supplied override here would silently leak every future claim
     * and close. Server-side forcing closes that hole.
     */
    async initPositionTx(
      req: FastifyRequest<{
        Body: {
          stealth: string;
          lbPair: string;
          lowerBinId: number;
          width: number;
          // Accepted for back-compat and explicitly ignored. New clients
          // should omit it.
          exitRecipient?: string;
        };
      }>,
      reply: FastifyReply,
    ) {
      const { stealth, lbPair, lowerBinId, width } = req.body;
      const stealthPubkey = new PublicKey(stealth);
      const result = await executor.buildInitPositionTx({
        stealth: stealthPubkey,
        lbPair: new PublicKey(lbPair),
        exitRecipient: stealthPubkey,
        lowerBinId,
        width,
      });
      return reply.send(result);
    },

    /**
     * POST /executor/add-liquidity-tx
     *
     * Single-sided SOL deposit for the private flow. Body:
     *   stealth          — the stealth wallet pubkey (already funded by mixer.withdraw)
     *   config           — the TestPairConfig from /executor/use-pool
     *   totalSolLamports — total SOL deposit in lamports (must equal mixer denomination)
     *   shape            — distribution shape: spot | curve | bid-ask
     */
    async addLiquidityTx(
      req: FastifyRequest<{
        Body: {
          stealth: string;
          config: TestPairConfig;
          totalSolLamports: string;
          shape: "spot" | "curve" | "bid-ask";
        };
      }>,
      reply: FastifyReply,
    ) {
      const { stealth, config, totalSolLamports, shape } = req.body;
      try {
        const result = await executor.buildAddLiquidityTx({
          stealth: new PublicKey(stealth),
          config,
          totalSolLamports: BigInt(totalSolLamports),
          shape,
        });
        return reply.send(result);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[/executor/add-liquidity-tx] failed:", err instanceof Error ? err.stack : err);
        return reply
          .status(400)
          .send({ error: err instanceof Error ? err.message : "add-liquidity-tx failed" });
      }
    },

    /**
     * POST /executor/claim-fees-tx
     * Body: { stealth, config } — exit_recipient is read from PoolAuthority.
     */
    async claimFeesTx(
      req: FastifyRequest<{ Body: { stealth: string; config: TestPairConfig } }>,
      reply: FastifyReply,
    ) {
      const { stealth, config } = req.body;
      try {
        const result = await executor.buildClaimFeesTx({
          stealth: new PublicKey(stealth),
          config,
        });
        return reply.send(result);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[/executor/claim-fees-tx] failed:", err instanceof Error ? err.stack : err);
        return reply
          .status(400)
          .send({ error: err instanceof Error ? err.message : "claim-fees-tx failed" });
      }
    },

    /**
     * POST /executor/withdraw-close-tx
     * Body: { stealth, config } — exit_recipient is read from PoolAuthority.
     * Always full exit (BPS=10000) per the MVP scope decision.
     */
    async withdrawCloseTx(
      req: FastifyRequest<{ Body: { stealth: string; config: TestPairConfig } }>,
      reply: FastifyReply,
    ) {
      const { stealth, config } = req.body;
      try {
        const result = await executor.buildWithdrawCloseTx({
          stealth: new PublicKey(stealth),
          config,
        });
        return reply.send(result);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[/executor/withdraw-close-tx] failed:", err instanceof Error ? err.stack : err);
        return reply
          .status(400)
          .send({ error: err instanceof Error ? err.message : "withdraw-close-tx failed" });
      }
    },

    /** GET /executor/pool-authority?stealth=...&lbPair=... */
    async poolAuthority(
      req: FastifyRequest<{ Querystring: { stealth: string; lbPair: string } }>,
      reply: FastifyReply,
    ) {
      if (!req.query.lbPair) {
        return reply.status(400).send({ error: "lbPair query param is required" });
      }
      const result = await executor.fetchPositionAuthority(
        new PublicKey(req.query.stealth),
        new PublicKey(req.query.lbPair),
      );
      if (!result) return reply.status(404).send({ error: "PoolAuthority not initialised" });
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

    /**
     * GET /executor/position-state?lbPair=...&positionPubkey=...
     *
     * Returns on-chain Meteora DLMM position state (range, totals, fees)
     * with USD conversions so the portfolio UI can render claimable/value
     * from the chain instead of the deposit-time snapshot.
     */
    async positionState(
      req: FastifyRequest<{ Querystring: { lbPair: string; positionPubkey: string } }>,
      reply: FastifyReply,
    ) {
      if (!req.query.lbPair || !req.query.positionPubkey) {
        return reply
          .status(400)
          .send({ error: "lbPair and positionPubkey query params are required" });
      }
      try {
        const result = await executor.getPositionState({
          lbPair: new PublicKey(req.query.lbPair),
          positionPubkey: new PublicKey(req.query.positionPubkey),
        });
        if (!result) return reply.status(404).send({ error: "position not found" });
        return reply.send(result);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          "[/executor/position-state] failed:",
          err instanceof Error ? err.stack : err,
        );
        return reply
          .status(400)
          .send({ error: err instanceof Error ? err.message : "position-state failed" });
      }
    },

    /** POST /executor/use-pool — body: { lbPair, width?, lowerBinId? } */
    async usePool(
      req: FastifyRequest<{
        Body: { lbPair: string; width?: number; lowerBinId?: number };
      }>,
      reply: FastifyReply,
    ) {
      try {
        const config = await executor.useExistingPool({
          lbPair: new PublicKey(req.body.lbPair),
          width: req.body.width,
          lowerBinId: req.body.lowerBinId,
        });
        return reply.send(config);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[/executor/use-pool] failed:", err instanceof Error ? err.stack : err);
        return reply
          .status(400)
          .send({ error: err instanceof Error ? err.message : "use-pool failed" });
      }
    },
  };
}
