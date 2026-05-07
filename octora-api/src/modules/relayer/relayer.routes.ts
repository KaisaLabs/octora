import type { FastifyInstance } from "fastify";
import { PublicKey } from "@solana/web3.js";
import type { MixerRelayerConfig } from "#common/config";
import { makeRateLimiter } from "#modules/mixer/rate-limit";
import { RelayerService } from "./relayer.service.js";
import { OnChainNullifierRegistry } from "./nullifier-registry.js";
import { createMixerClient, deriveMixerPoolPDA } from "./solana-client.js";
import type { RelayerConfig, WithdrawRequest } from "./types.js";

/**
 * Mixer relayer routes.
 *
 * Wires up `RelayerService` against the **on-chain** nullifier registry —
 * NEVER use `InMemoryNullifierRegistry` here. In-memory state evaporates on
 * restart, opening a window where the cache is empty and concurrent dup
 * requests both pass the cache check; the on-chain variant uses the
 * authoritative PDA-existence check as the source of truth.
 *
 * Disabled by default. Set `OCTORA_MIXER_RELAYER_ENABLED=true` plus the
 * other `OCTORA_MIXER_RELAYER_*` env vars to turn it on. The relayer holds
 * a hot wallet, so do NOT enable it on serverless deploys where the
 * filesystem is shared or env vars are logged.
 */
export async function registerRelayerRoutes(
  app: FastifyInstance,
  cfg: MixerRelayerConfig,
): Promise<void> {
  const tags = ["Relayer"];

  const serviceConfig: RelayerConfig = {
    // baseFeelamports is informational metadata — minFeeLamports is the
    // actual gate enforced in `guardRequest`. Setting them equal means the
    // advertised fee floor matches what's actually charged.
    baseFeelamports: cfg.minFeeLamports,
    minFeeLamports: cfg.minFeeLamports,
    hotWalletSecret: cfg.hotWalletSecret,
    rpcUrl: cfg.rpcUrl,
    mixerProgramId: cfg.mixerProgramId,
    poolDenomination: cfg.poolDenomination,
  };

  // Build the Solana client once, derive the pool PDA, and use that to
  // construct the on-chain nullifier registry. The same client instance
  // is reused inside RelayerService when it calls initializeClient().
  const client = createMixerClient(serviceConfig);
  const [poolPDA] = deriveMixerPoolPDA(client.programId, cfg.poolDenomination);

  const nullifiers = new OnChainNullifierRegistry(
    client.provider.connection,
    client.programId,
    poolPDA,
  );

  const relayer = new RelayerService(serviceConfig, nullifiers);
  relayer.initializeClient();

  app.log.info(
    {
      hotWallet: client.hotWallet.publicKey.toBase58(),
      poolPDA: poolPDA.toBase58(),
      programId: client.programId.toBase58(),
      denomination: cfg.poolDenomination.toString(),
      minFeeLamports: cfg.minFeeLamports.toString(),
    },
    "mixer relayer initialized",
  );

  // Rate-limit ceilings:
  //   - withdraw is the expensive endpoint (hits proof verification +
  //     RPC submission), so 10/min/IP keeps a single abusive client from
  //     burning the relayer's CPU.
  //   - validate is a dry-run, slightly more permissive but still
  //     bounded so it can't be used to spam the verifier.
  //   - status is read-only, looser limit.
  const withdrawLimiter = makeRateLimiter({ windowMs: 60_000, max: 10 });
  const validateLimiter = makeRateLimiter({ windowMs: 60_000, max: 30 });
  const statusLimiter = makeRateLimiter({ windowMs: 60_000, max: 60 });

  await app.register(async (scope) => {
    scope.addHook("onRequest", statusLimiter);
    scope.get(
      "/relayer/status",
      { schema: { tags } },
      async () => {
        const status = await relayer.status();
        return status;
      },
    );

    // /relayer/health is shaped for monitoring tools: returns 200 when
    // healthy, 503 when any threshold trips (low balance, queue
    // backed up, client uninitialized). The body lists the specific
    // failed checks so a human can debug without consulting logs.
    scope.get(
      "/relayer/health",
      { schema: { tags } },
      async (_req, reply) => {
        const health = await relayer.health();
        if (!health.healthy) reply.code(503);
        return health;
      },
    );
  });

  await app.register(async (scope) => {
    scope.addHook("onRequest", validateLimiter);
    scope.post<{ Body: WithdrawRequest }>(
      "/relayer/validate",
      { schema: { tags } },
      async (req) => {
        const body = parseWithdrawBody(req.body);
        return relayer.validateProof(body);
      },
    );
  });

  await app.register(async (scope) => {
    scope.addHook("onRequest", withdrawLimiter);
    scope.post<{ Body: WithdrawRequest }>(
      "/relayer/withdraw",
      { schema: { tags } },
      async (req, reply) => {
        const body = parseWithdrawBody(req.body);
        const result = await relayer.processWithdrawal(body);
        if (!result.success) {
          // 4xx vs 5xx isn't worth a deep distinction here — the body
          // tells the client what went wrong. Use 400 for "valid request,
          // refused" and let unhandled errors bubble to Fastify's 500.
          reply.code(400);
        }
        return result;
      },
    );
  });
}

/**
 * Lightweight runtime check that the request body has the right shape.
 * Fastify will already have parsed JSON; we just guard against missing
 * fields so the relayer's proof verifier doesn't crash on undefined.
 */
function parseWithdrawBody(body: unknown): WithdrawRequest {
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
    "relayer",
    "fee",
  ] as const;
  for (const k of required) {
    if (b[k] === undefined || b[k] === null) {
      throw new Error(`Missing required field: ${k}`);
    }
  }
  // recipient + relayer must be valid base58 pubkeys; reject early so the
  // service doesn't have to special-case malformed strings.
  try {
    new PublicKey(b.recipient as string);
    new PublicKey(b.relayer as string);
  } catch (err) {
    throw new Error(
      `recipient/relayer must be valid base58 pubkeys: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
  return b as unknown as WithdrawRequest;
}
