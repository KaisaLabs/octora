import type { FastifyInstance } from "fastify";
import { PublicKey } from "@solana/web3.js";
import type { MixerRelayerConfig } from "#common/config";
import { makeRateLimiter } from "#modules/mixer/rate-limit";
import {
  createRelayerController,
  type RelayerEntry,
  type WithdrawBody,
} from "./relayer.controller.js";
import { RelayerRegistry } from "./relayer.registry.js";
import type { RootSeenRepository } from "./root-seen.repository.js";
import {
  InvalidDenominationError,
  MixerRegistry,
  UnknownDenominationError,
  parseDenomination,
} from "#modules/mixer/mixer.registry";
import { AnonymitySetTooThinError } from "#modules/mixer/mixer.service";

/**
 * Mixer relayer routes.
 *
 * Wires N `RelayerService` instances (one per configured pool denomination)
 * behind a single set of routes. Each endpoint accepts an optional
 * `denomination` parameter; when absent, the registry default is used —
 * preserves single-denom behaviour for legacy clients.
 *
 * Disabled by default. Set `OCTORA_MIXER_RELAYER_ENABLED=true` plus the
 * other `OCTORA_MIXER_RELAYER_*` env vars to turn it on. The relayer holds
 * a hot wallet, so do NOT enable it on serverless deploys where the
 * filesystem is shared or env vars are logged.
 *
 * Endpoints:
 *   GET  /relayer/info         — multi-pool info bundle (relayer pubkey + per-denom pool addresses)
 *   GET  /relayer/status       — per-denom counters / hot-wallet balance
 *   GET  /relayer/health       — 503 when any pool is unhealthy
 *   POST /relayer/validate     — dry-run proof verification
 *   POST /relayer/withdraw     — submit a proven withdrawal; relayer pays gas
 */
export async function registerRelayerRoutes(
  app: FastifyInstance,
  cfg: MixerRelayerConfig,
  rootSeenRepo: RootSeenRepository | null = null,
  mixerRegistry: MixerRegistry | null = null,
): Promise<void> {
  const tags = ["Relayer"];

  if (!rootSeenRepo) {
    app.log.warn(
      "mixer relayer running without a root-seen repository — privacy-delay gate is disabled.",
    );
  }

  const registry = await RelayerRegistry.create(cfg, rootSeenRepo);

  app.log.info(
    {
      hotWallet: registry.infoBundle.relayerPubkey,
      denominations: registry.denominations.map((d) => d.toString()),
      pools: registry.infoBundle.pools,
    },
    "mixer relayer initialized",
  );

  const resolver = (denomination?: bigint): RelayerEntry =>
    registry.get(denomination ?? registry.defaultDenomination);

  // Wire the anonymity-set tracker into the relayer pipeline:
  //   - `preSubmit` enforces MIN_ANONYMITY_SET *before* gas is paid.
  //   - `postCommit` marks the spent nullifier so the next /mixer/pools
  //     and the next withdraw build see the updated count immediately,
  //     without waiting for an on-chain re-scan.
  // When `mixerRegistry` is null (single-process test wiring with no
  // mixer routes registered), both hooks no-op and the relayer behaves
  // as it did before the gate existed.
  const controller = createRelayerController(resolver, registry.infoBundle, {
    preSubmit: async (entry) => {
      if (!mixerRegistry) return;
      const denom = BigInt(entry.info.denominationLamports);
      await mixerRegistry.get(denom).assertAnonymitySetSatisfied();
    },
    postCommit: (entry, body) => {
      if (!mixerRegistry) return;
      const denom = BigInt(entry.info.denominationLamports);
      mixerRegistry.get(denom).recordWithdrawal(body.nullifierHash);
    },
  });

  // Rate-limit ceilings:
  //   - withdraw is the expensive endpoint, 10/min/IP
  //   - validate is a dry-run, 30/min/IP
  //   - status/info are read-only, 60/min/IP
  const withdrawLimiter = makeRateLimiter({ windowMs: 60_000, max: 10 });
  const validateLimiter = makeRateLimiter({ windowMs: 60_000, max: 30 });
  const statusLimiter = makeRateLimiter({ windowMs: 60_000, max: 60 });

  function resolveDenominationParam(
    raw: unknown,
    reply: import("fastify").FastifyReply,
  ): RelayerEntry | null {
    let denomination: bigint | null;
    try {
      denomination = parseDenomination(raw);
    } catch (err) {
      reply
        .status(400)
        .send({ error: err instanceof Error ? err.message : "invalid denomination" });
      return null;
    }
    try {
      return resolver(denomination ?? undefined);
    } catch (err) {
      if (err instanceof UnknownDenominationError) {
        reply.status(400).send({
          error: err.message,
          requested: err.requested.toString(),
          available: err.available.map((d) => d.toString()),
        });
        return null;
      }
      if (err instanceof InvalidDenominationError) {
        reply.status(400).send({ error: err.message });
        return null;
      }
      throw err;
    }
  }

  await app.register(async (scope) => {
    scope.addHook("onRequest", statusLimiter);

    scope.get("/relayer/info", { schema: { tags } }, controller.getInfo);

    scope.get<{ Querystring: { denomination?: string } }>(
      "/relayer/status",
      { schema: { tags } },
      async (req, reply) => {
        const entry = resolveDenominationParam(req.query?.denomination, reply);
        if (!entry) return;
        return entry.service.status();
      },
    );

    // /relayer/health aggregates across every configured pool. The
    // top-level `healthy` flag is the AND of all per-pool flags so a
    // single failing pool flips the LB out of rotation — preferred over
    // silently routing around a degraded denomination.
    scope.get(
      "/relayer/health",
      { schema: { tags } },
      async (_req, reply) => {
        const perPool = await Promise.all(
          registry.list().map(async (entry) => {
            const health = await entry.service.health();
            return { denomination: entry.info.denominationLamports, ...health };
          }),
        );
        const overall = perPool.every((p) => p.healthy);
        if (!overall) reply.code(503);
        return { healthy: overall, pools: perPool };
      },
    );
  });

  await app.register(async (scope) => {
    scope.addHook("onRequest", validateLimiter);
    scope.post<{ Body: WithdrawBody }>(
      "/relayer/validate",
      { schema: { tags } },
      async (req, reply) => {
        const entry = resolveDenominationParam(req.body?.denomination, reply);
        if (!entry) return;
        const body = parseWithdrawBody(req.body);
        return entry.service.validateProof({ ...body, relayer: entry.info.relayerPubkey });
      },
    );
  });

  await app.register(async (scope) => {
    scope.addHook("onRequest", withdrawLimiter);
    // The controller delegates the gate to the `preSubmit` hook wired
    // above; we surface `AnonymitySetTooThinError` here as HTTP 400 so
    // the structured error matches the `/mixer/withdraw` shape.
    scope.setErrorHandler((err, _req, reply) => {
      if (err instanceof AnonymitySetTooThinError) {
        return reply.status(400).send({
          error: err.code,
          message: err.message,
          current: err.current,
          required: err.required,
          denomination: err.denomination.toString(),
        });
      }
      throw err;
    });
    scope.post<{ Body: WithdrawBody }>(
      "/relayer/withdraw",
      { schema: { tags } },
      controller.withdraw,
    );
  });
}

/**
 * Lightweight runtime check that the request body has the right shape.
 * Fastify will already have parsed JSON; we just guard against missing
 * fields so the relayer's proof verifier doesn't crash on undefined.
 */
function parseWithdrawBody(body: unknown): Omit<WithdrawBody, "relayer"> & { relayer?: string } {
  if (!body || typeof body !== "object") {
    throw new Error("Body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;
  const required = [
    "proof",
    "publicSignals",
    "root",
    "nullifierHash",
    "recipient",
    "fee",
  ] as const;
  for (const k of required) {
    if (b[k] === undefined || b[k] === null) {
      throw new Error(`Missing required field: ${k}`);
    }
  }
  try {
    new PublicKey(b.recipient as string);
  } catch (err) {
    throw new Error(
      `recipient must be a valid base58 pubkey: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
  return b as unknown as Omit<WithdrawBody, "relayer"> & { relayer?: string };
}
