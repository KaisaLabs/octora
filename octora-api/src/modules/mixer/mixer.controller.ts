import type { FastifyReply, FastifyRequest } from "fastify";
import type { MixerService } from "./mixer.service.js";

export function createMixerController(mixer: MixerService) {
  return {
    /** GET /mixer/status */
    async getStatus(_req: FastifyRequest, reply: FastifyReply) {
      const status = await mixer.getPoolStatus();
      if (!status) {
        return reply.status(404).send({ error: "Pool not initialized on-chain" });
      }
      return reply.send(status);
    },

    /** POST /mixer/initialize — build unsigned init tx */
    async initialize(
      req: FastifyRequest<{ Body: { authority: string } }>,
      reply: FastifyReply,
    ) {
      const { authority } = req.body;
      const result = await mixer.buildInitializeTransaction(authority);
      return reply.send(result);
    },

    /** GET /mixer/deposits — public history for browser-side tree reconstruction */
    async listDeposits(_req: FastifyRequest, reply: FastifyReply) {
      return reply.send({ deposits: mixer.listDeposits() });
    },

    /** POST /mixer/deposit — build unsigned deposit tx */
    async deposit(
      req: FastifyRequest<{
        Body: {
          depositor: string;
          commitment: string;
          newRoot: string;
          leafIndex: number;
        };
      }>,
      reply: FastifyReply,
    ) {
      const { depositor, commitment, newRoot, leafIndex } = req.body;
      try {
        const result = await mixer.buildDepositTransaction({
          depositorPubkey: depositor,
          commitment: BigInt(commitment),
          newRoot: BigInt(newRoot),
          leafIndex,
        });
        return reply.send(result);
      } catch (err) {
        return reply
          .status(400)
          .send({ error: err instanceof Error ? err.message : "deposit build failed" });
      }
    },

    /**
     * POST /mixer/confirm-deposit — record an on-chain deposit so the
     * browser-served deposit history stays in sync. Best-effort.
     */
    async confirmDeposit(
      req: FastifyRequest<{
        Body: { commitment: string; leafIndex: number; txSignature: string };
      }>,
      reply: FastifyReply,
    ) {
      const { commitment, leafIndex, txSignature } = req.body;
      mixer.recordDeposit(BigInt(commitment), leafIndex, txSignature);
      return reply.send({ ok: true });
    },

    /** POST /mixer/withdraw — build unsigned withdraw tx */
    async withdraw(
      req: FastifyRequest<{
        Body: {
          signer: string;
          recipient: string;
          proofBytes: string;
          publicInputsBytes: string;
          nullifierHash: string;
        };
      }>,
      reply: FastifyReply,
    ) {
      const { signer, recipient, proofBytes, publicInputsBytes, nullifierHash } = req.body;
      const result = await mixer.buildWithdrawTransaction(
        signer,
        recipient,
        proofBytes,
        publicInputsBytes,
        nullifierHash,
      );
      return reply.send(result);
    },
  };
}
