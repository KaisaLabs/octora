import type { FastifyReply, FastifyRequest } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { AnonymitySetTooThinError, MIN_ANONYMITY_SET, MixerService } from "./mixer.service.js";
import {
  InvalidDenominationError,
  UnknownDenominationError,
  parseDenomination,
  type MixerServiceResolver,
} from "./mixer.registry.js";
import type { SolanaChain } from "#common/solana/chain";

export interface MixerPoolsDependencies {
  chain: SolanaChain;
  programId: PublicKey;
  denominations: bigint[];
}

/**
 * Mixer controller — dispatches each request to the right per-denomination
 * `MixerService` via the resolver, then surfaces the result. When a caller
 * omits `denomination`, the resolver falls back to the registry default,
 * which keeps single-denom deployments and existing tests working unchanged.
 */
export function createMixerController(
  resolve: MixerServiceResolver,
  pools?: MixerPoolsDependencies,
) {
  let poolsCache: { ts: number; payload: unknown } | null = null;
  const POOLS_TTL_MS = 30_000;

  function resolveService(denominationRaw: unknown, reply: FastifyReply): MixerService | null {
    let denomination: bigint | null;
    try {
      denomination = parseDenomination(denominationRaw);
    } catch (err) {
      reply.status(400).send({
        error: err instanceof Error ? err.message : "invalid denomination",
      });
      return null;
    }
    try {
      return resolve(denomination ?? undefined);
    } catch (err) {
      if (err instanceof UnknownDenominationError) {
        reply.status(400).send({
          error: err.message,
          requested: err.requested.toString(),
          available: err.available.map((d) => d.toString()),
        });
        return null;
      }
      throw err;
    }
  }

  return {
    /** GET /mixer/status?denomination=... */
    async getStatus(
      req: FastifyRequest<{ Querystring: { denomination?: string } }>,
      reply: FastifyReply,
    ) {
      const mixer = resolveService(req.query?.denomination, reply);
      if (!mixer) return;
      const status = await mixer.getPoolStatus();
      if (!status) {
        return reply.status(404).send({ error: "Pool not initialized on-chain" });
      }
      return reply.send(status);
    },

    /**
     * GET /mixer/pools — multi-pool snapshot for the denomination selector.
     * Returns one entry per configured denomination, with `initialized: false`
     * for pools whose on-chain account hasn't been created yet.
     */
    async listPools(_req: FastifyRequest, reply: FastifyReply) {
      if (!pools) {
        return reply
          .status(501)
          .send({ error: "Multi-pool config not wired — pass MixerPoolsDependencies." });
      }
      const now = Date.now();
      if (poolsCache && now - poolsCache.ts < POOLS_TTL_MS) {
        return reply.send(poolsCache.payload);
      }
      const results = await Promise.all(
        pools.denominations.map(async (denomination) => {
          const status = await MixerService.readPoolStatus(
            pools.chain,
            pools.programId,
            denomination,
          );
          if (!status) {
            return { denomination: denomination.toString(), initialized: false };
          }
          // The static reader can't know the per-pool withdrawal count
          // (the NullifierAccount data doesn't embed the pool key, so we
          // can't filter `getProgramAccounts`). Source the live service
          // snapshot instead — it's hydrated from WithdrawEvent log scans
          // at startup and kept warm by relayer callbacks.
          let withdrawalCount = status.withdrawalCount;
          let anonymitySet = status.anonymitySet;
          try {
            const svc = resolve(denomination);
            const snap = await svc.getAnonymitySetSnapshot();
            withdrawalCount = snap.withdrawalCount;
            anonymitySet = snap.anonymitySet;
          } catch {
            // Fallthrough to the optimistic static-reader value when this
            // denomination isn't in the registry (shouldn't happen with
            // the standard wiring, but keeps /mixer/pools resilient).
          }
          return {
            denomination: status.denomination,
            initialized: true,
            poolAddress: status.poolAddress,
            anonymitySet,
            anonymitySetMin: MIN_ANONYMITY_SET,
            depositCount: status.depositCount,
            withdrawalCount,
            isPaused: status.isPaused,
            balanceLamports: status.balance,
            nextLeafIndex: status.nextLeafIndex,
          };
        }),
      );
      const payload = { pools: results, anonymitySetMin: MIN_ANONYMITY_SET };
      poolsCache = { ts: now, payload };
      return reply.send(payload);
    },

    /** POST /mixer/initialize — build unsigned init tx */
    async initialize(
      req: FastifyRequest<{ Body: { authority: string; denomination?: string } }>,
      reply: FastifyReply,
    ) {
      const mixer = resolveService(req.body?.denomination, reply);
      if (!mixer) return;
      const result = await mixer.buildInitializeTransaction(req.body.authority);
      return reply.send(result);
    },

    /** GET /mixer/deposits?denomination=... */
    async listDeposits(
      req: FastifyRequest<{ Querystring: { denomination?: string } }>,
      reply: FastifyReply,
    ) {
      const mixer = resolveService(req.query?.denomination, reply);
      if (!mixer) return;
      return reply.send({ deposits: mixer.listDeposits() });
    },

    /** POST /mixer/deposit — body: { depositor, commitment, denomination? } */
    async deposit(
      req: FastifyRequest<{
        Body: { depositor: string; commitment: string; denomination?: string };
      }>,
      reply: FastifyReply,
    ) {
      const mixer = resolveService(req.body?.denomination, reply);
      if (!mixer) return;
      const { depositor, commitment } = req.body;
      try {
        const result = await mixer.buildDepositTransaction({
          depositorPubkey: depositor,
          commitment: BigInt(commitment),
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof InvalidDenominationError) {
          return reply.status(400).send({ error: err.message });
        }
        req.log.error({ err }, "[/mixer/deposit] build failed");
        return reply
          .status(400)
          .send({ error: err instanceof Error ? err.message : "deposit build failed" });
      }
    },

    /** POST /mixer/confirm-deposit */
    async confirmDeposit(
      req: FastifyRequest<{
        Body: {
          commitment: string;
          leafIndex: number;
          txSignature: string;
          denomination?: string;
        };
      }>,
      reply: FastifyReply,
    ) {
      const mixer = resolveService(req.body?.denomination, reply);
      if (!mixer) return;
      const { commitment, leafIndex, txSignature } = req.body;
      mixer.recordDeposit(BigInt(commitment), leafIndex, txSignature);
      return reply.send({ ok: true });
    },

    /** POST /mixer/withdraw */
    async withdraw(
      req: FastifyRequest<{
        Body: {
          signer: string;
          recipient: string;
          proofBytes: string;
          publicInputsBytes: string;
          nullifierHash: string;
          denomination?: string;
        };
      }>,
      reply: FastifyReply,
    ) {
      const mixer = resolveService(req.body?.denomination, reply);
      if (!mixer) return;
      const { signer, recipient, proofBytes, publicInputsBytes, nullifierHash } = req.body;
      try {
        const result = await mixer.buildWithdrawTransaction(
          signer,
          recipient,
          proofBytes,
          publicInputsBytes,
          nullifierHash,
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof AnonymitySetTooThinError) {
          return reply.status(400).send({
            error: err.code,
            message: err.message,
            current: err.current,
            required: err.required,
            denomination: err.denomination.toString(),
          });
        }
        req.log.error({ err }, "[/mixer/withdraw] build failed");
        return reply
          .status(400)
          .send({ error: err instanceof Error ? err.message : "withdraw build failed" });
      }
    },
  };
}
