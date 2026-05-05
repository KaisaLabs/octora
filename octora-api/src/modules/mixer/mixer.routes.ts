import type { FastifyInstance } from "fastify";
import { MixerService } from "./mixer.service.js";
import { createMixerController } from "./mixer.controller.js";
import { makeRateLimiter } from "./rate-limit.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
// 0.025 SOL. Bumped from 0.02 because the old default's mixer_pool PDA on
// devnet was initialised by a pre-`filled_subtrees` build of the program,
// so Anchor can't deserialize it against the current MixerPool layout.
// A new denomination → new PDA → fresh account, no migration needed.
const DENOMINATION = BigInt(process.env.MIXER_DENOMINATION || "25000000");

// Rate-limit ceilings — chosen to allow normal interactive use of the test
// page (a few clicks per minute) while bounding what an abusive client can
// do. /mixer/withdraw and /mixer/deposit each cost an RPC roundtrip
// (getLatestBlockhash) so they're tighter; the read-only endpoints are
// mostly cache hits and can be looser.
const WRITE_LIMIT = { windowMs: 60_000, max: 30 };
const READ_LIMIT = { windowMs: 60_000, max: 120 };

/**
 * Mixer routes intentionally do NOT include endpoints for:
 *   - generating commitments (secret + nullifier)
 *   - generating stealth wallets (private key)
 *   - generating ZK proofs (consumes secret + nullifier as private witness)
 *
 * Those operations all require the user's secret material and must happen
 * in the user's browser. Exposing them here would let the API operator
 * (or anyone with access to logs / network traces) withdraw any deposit.
 *
 * The browser-side equivalents live in octora-web/src/lib/mixer/.
 */
export async function registerMixerRoutes(app: FastifyInstance) {
  const tags = ["Mixer"];

  const mixer = new MixerService({
    rpcUrl: RPC_URL,
    denomination: DENOMINATION,
  });

  // Rehydrate the deposit cache from on-chain DepositEvent logs so a
  // server restart doesn't blank the public deposit history that
  // browsers rely on for Merkle-tree reconstruction. Best-effort and
  // non-blocking: kicked off in the background — /mixer/deposits will
  // still serve whatever is loaded so far, and /mixer/confirm-deposit
  // can backfill anything we miss.
  void mixer
    .hydrateFromChain({ log: (m) => app.log.warn(m) })
    .then((res) => {
      app.log.info(
        { depositsLoaded: res.depositsLoaded, scannedSignatures: res.scannedSignatures },
        "mixer: hydrated deposit cache from chain",
      );
    })
    .catch((err) => {
      app.log.warn({ err }, "mixer: hydrateFromChain failed");
    });

  const controller = createMixerController(mixer);

  // Independent buckets per route family so heavy abuse on one endpoint
  // doesn't starve unrelated reads. Applied via scoped onRequest hooks
  // inside two `register` blocks so each route's request-body inference
  // (which collides with route-level preHandler typing) stays clean.
  const readLimiter = makeRateLimiter(READ_LIMIT);
  const writeLimiter = makeRateLimiter(WRITE_LIMIT);

  // ── Read-only endpoints (looser limit) ─────────────────────────
  await app.register(async (scope) => {
    scope.addHook("onRequest", readLimiter);

    // Pool status
    scope.get("/mixer/status", { schema: { tags } }, controller.getStatus);

    // Public deposit history — used by the browser to reconstruct the Merkle
    // tree locally before computing inclusion proofs. Returns only public data.
    scope.get("/mixer/deposits", { schema: { tags } }, controller.listDeposits);
  });

  // ── Build-an-unsigned-tx / write-ish endpoints (tighter limit) ─
  await app.register(async (scope) => {
    scope.addHook("onRequest", writeLimiter);

    // Initialize pool (build unsigned tx)
    scope.post("/mixer/initialize", { schema: { tags } }, controller.initialize);

    // Build deposit transaction (unsigned, frontend signs).
    // Body: { depositor, commitment } — the on-chain program computes the new
    // Merkle root deterministically.
    scope.post("/mixer/deposit", { schema: { tags } }, controller.deposit);

    // Record a confirmed deposit so future depositors can rebuild the tree.
    // Best-effort: even if this fails, the on-chain DepositEvent is the
    // authoritative source (and the next server start will pick it up via
    // hydrateFromChain).
    scope.post(
      "/mixer/confirm-deposit",
      { schema: { tags } },
      controller.confirmDeposit,
    );

    // Build withdraw transaction (unsigned, frontend signs).
    // Proof + public-input bytes come from the browser-side prover.
    scope.post("/mixer/withdraw", { schema: { tags } }, controller.withdraw);
  });
}
