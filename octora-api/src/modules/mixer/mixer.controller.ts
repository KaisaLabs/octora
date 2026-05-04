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

    /** POST /mixer/commitment — generate a fresh commitment */
    async generateCommitment(_req: FastifyRequest, reply: FastifyReply) {
      const commitment = await mixer.generateCommitment();
      return reply.send({
        secret: commitment.secret.toString(),
        nullifier: commitment.nullifier.toString(),
        commitment: commitment.commitment.toString(),
        nullifierHash: commitment.nullifierHash.toString(),
      });
    },

    /** POST /mixer/deposit — build unsigned deposit tx */
    async deposit(
      req: FastifyRequest<{
        Body: { depositor: string; commitment: string };
      }>,
      reply: FastifyReply,
    ) {
      const { depositor, commitment } = req.body;
      const result = await mixer.buildDepositTransaction(
        depositor,
        BigInt(commitment),
      );
      return reply.send({
        transaction: result.transaction,
        newRoot: result.newRoot,
        leafIndex: result.leafIndex,
      });
    },

    /** POST /mixer/stealth-wallet — generate a stealth wallet */
    async generateStealth(_req: FastifyRequest, reply: FastifyReply) {
      const wallet = mixer.generateStealthWallet();
      return reply.send(wallet);
    },

    /** POST /mixer/prove — generate ZK proof for withdrawal */
    async prove(
      req: FastifyRequest<{
        Body: {
          secret: string;
          nullifier: string;
          leafIndex: number;
          recipient: string;
          relayer: string;
          fee: string;
        };
      }>,
      reply: FastifyReply,
    ) {
      const { secret, nullifier, leafIndex, recipient, relayer, fee } = req.body;
      const result = await mixer.generateProof(
        secret,
        nullifier,
        leafIndex,
        recipient,
        relayer,
        fee,
      );
      return reply.send({
        proof: result.proof,
        publicSignals: result.publicSignals,
        proofBytes: result.proofBytes,
        publicInputsBytes: result.publicInputsBytes,
      });
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
