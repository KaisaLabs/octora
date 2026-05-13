import type { FastifyInstance } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { createMixerController } from "./mixer.controller.js";
import { MixerRegistry } from "./mixer.registry.js";
import { makeRateLimiter } from "./rate-limit.js";
import { loadConfig } from "#common/config";

// MAINNET_BLOCKER: default falls back to devnet. On mainnet deploy,
// SOLANA_RPC_URL must be set explicitly to a real provider (Helius,
// Triton, etc.) — public mainnet-beta rate-limits aggressively and
// `getSignaturesForAddress` truncates under load. See docs/test-plan.md §14.
const appConfig = loadConfig();
const RPC_URL = appConfig.solanaRpcUrl;

const WRITE_LIMIT = { windowMs: 60_000, max: 30 };
const READ_LIMIT = { windowMs: 60_000, max: 120 };

/**
 * Mixer routes intentionally do NOT include endpoints for:
 *   - generating commitments (secret + nullifier)
 *   - generating stealth wallets (private key)
 *   - generating ZK proofs
 *
 * Those operations require the user's secret material and must happen in
 * the user's browser. Exposing them here would let the API operator (or
 * anyone with log/network access) withdraw any deposit. The browser-side
 * equivalents live in octora-web/src/lib/mixer/.
 */
export interface MixerRoutesOptions {
  mixerProgramId: string;
  /**
   * All configured pool denominations (lamports). The first entry is the
   * default denomination used when a caller omits `denomination` on a
   * request — preserves single-denom behaviour for legacy clients.
   */
  mixerDenominations: bigint[];
  /**
   * Optional pre-built registry. Pass when other routes (e.g. the relayer)
   * need to share the same per-denom `MixerService` instances so the
   * anonymity-set tracker stays consistent across endpoints.
   */
  registry?: MixerRegistry;
}

export async function registerMixerRoutes(
  app: FastifyInstance,
  opts: MixerRoutesOptions,
) {
  const tags = ["Mixer"];

  const programId = new PublicKey(opts.mixerProgramId);
  const registry =
    opts.registry ??
    new MixerRegistry({
      rpcUrl: RPC_URL,
      programId,
      denominations: opts.mixerDenominations,
    });

  // Rehydrate the deposit cache from on-chain logs for every configured
  // pool. Without per-pool hydration, a server restart would blank the
  // public deposit history for non-default denominations and any browser
  // rebuilding the Merkle tree would see a partial leaf set → RootNotFound.
  // Skipped under vitest: tests hit `createApp` repeatedly, and N pools ×
  // public-RPC 429-backoff blows past the 10s hook timeout.
  if (!appConfig.isTest) {
    await Promise.all(
      registry.list().map(async ({ denomination, service }) => {
        try {
          const res = await service.hydrateFromChain({ log: (m) => app.log.warn(m) });
          app.log.info(
            {
              denomination: denomination.toString(),
              depositsLoaded: res.depositsLoaded,
              scannedSignatures: res.scannedSignatures,
            },
            "mixer: hydrated deposit cache from chain",
          );
        } catch (err) {
          app.log.warn(
            { err, denomination: denomination.toString() },
            "mixer: hydrateFromChain failed",
          );
        }
      }),
    );
  }

  const controller = createMixerController(
    (denomination) => registry.get(denomination ?? registry.defaultDenomination),
    {
      rpcUrl: RPC_URL,
      programId,
      denominations: [...registry.denominations],
    },
  );

  const readLimiter = makeRateLimiter(READ_LIMIT);
  const writeLimiter = makeRateLimiter(WRITE_LIMIT);

  // ── Read-only endpoints ────────────────────────────────────────
  await app.register(async (scope) => {
    scope.addHook("onRequest", readLimiter);
    scope.get("/mixer/status", { schema: { tags } }, controller.getStatus);
    scope.get("/mixer/pools", { schema: { tags } }, controller.listPools);
    scope.get("/mixer/deposits", { schema: { tags } }, controller.listDeposits);
  });

  // ── Write-ish (build-an-unsigned-tx) endpoints ─────────────────
  await app.register(async (scope) => {
    scope.addHook("onRequest", writeLimiter);
    scope.post("/mixer/initialize", { schema: { tags } }, controller.initialize);
    scope.post("/mixer/deposit", { schema: { tags } }, controller.deposit);
    scope.post(
      "/mixer/confirm-deposit",
      { schema: { tags } },
      controller.confirmDeposit,
    );
    scope.post("/mixer/withdraw", { schema: { tags } }, controller.withdraw);
  });
}
