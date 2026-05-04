import type { FastifyInstance } from "fastify";
import { MixerService } from "./mixer.service.js";
import { createMixerController } from "./mixer.controller.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "http://localhost:8899";
const DENOMINATION = BigInt(process.env.MIXER_DENOMINATION || "20000000"); // 0.02 SOL

export async function registerMixerRoutes(app: FastifyInstance) {
  const tags = ["Mixer"];

  const mixer = new MixerService({
    rpcUrl: RPC_URL,
    denomination: DENOMINATION,
  });
  await mixer.initialize();

  const controller = createMixerController(mixer);

  // Pool status
  app.get("/mixer/status", { schema: { tags } }, controller.getStatus);

  // Initialize pool (build unsigned tx)
  app.post("/mixer/initialize", { schema: { tags } }, controller.initialize);

  // Generate commitment (secret + nullifier + commitment hash)
  app.get("/mixer/commitment", { schema: { tags } }, controller.generateCommitment);

  // Build deposit transaction (unsigned, frontend signs)
  app.post("/mixer/deposit", { schema: { tags } }, controller.deposit);

  // Generate stealth wallet
  app.get("/mixer/stealth-wallet", { schema: { tags } }, controller.generateStealth);

  // Generate ZK proof for withdrawal
  app.post("/mixer/prove", { schema: { tags } }, controller.prove);

  // Build withdraw transaction (unsigned, frontend signs)
  app.post("/mixer/withdraw", { schema: { tags } }, controller.withdraw);
}
