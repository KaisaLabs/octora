import type { FastifyInstance } from "fastify";
import { MixerService } from "./mixer.service.js";
import { createMixerController } from "./mixer.controller.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "http://localhost:8899";
const DENOMINATION = BigInt(process.env.MIXER_DENOMINATION || "20000000"); // 0.02 SOL

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

  const controller = createMixerController(mixer);

  // Pool status
  app.get("/mixer/status", { schema: { tags } }, controller.getStatus);

  // Initialize pool (build unsigned tx)
  app.post("/mixer/initialize", { schema: { tags } }, controller.initialize);

  // Public deposit history — used by the browser to reconstruct the Merkle
  // tree locally before computing inclusion proofs. Returns only public data.
  app.get("/mixer/deposits", { schema: { tags } }, controller.listDeposits);

  // Build deposit transaction (unsigned, frontend signs).
  // Body: { depositor, commitment, newRoot, leafIndex } — newRoot/leafIndex
  // are computed client-side against the local tree.
  app.post("/mixer/deposit", { schema: { tags } }, controller.deposit);

  // Record a confirmed deposit so future depositors can rebuild the tree.
  // Best-effort: even if this fails, the on-chain DepositEvent is the
  // authoritative source.
  app.post("/mixer/confirm-deposit", { schema: { tags } }, controller.confirmDeposit);

  // Build withdraw transaction (unsigned, frontend signs).
  // Proof + public-input bytes come from the browser-side prover.
  app.post("/mixer/withdraw", { schema: { tags } }, controller.withdraw);
}
