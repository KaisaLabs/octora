import type { FastifyInstance } from "fastify";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { ExecutorService } from "./executor.service.js";
import { createExecutorController } from "./executor.controller.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "http://localhost:8899";
const EXECUTOR_PROGRAM_ID =
  process.env.OCTORA_EXECUTOR_PROGRAM_ID || "86zj6EvHxMywP4Bw4EyZ2VcAjLm1pfGsc6ZjsZbrWwwc";
const RELAYER_KEYPAIR_PATH =
  process.env.OCTORA_EXECUTOR_RELAYER_KEYPAIR ||
  `${process.env.HOME ?? ""}/.config/solana/id.json`;

/**
 * Test-page executor routes. These power the integrated test page:
 * /executor/setup-pair (server admin), /executor/init-position-tx,
 * /executor/add-liquidity-tx, /executor/withdraw-close-tx.
 *
 * Stealth keypair signatures NEVER touch the server — every tx-building
 * endpoint returns a partially-signed (or unsigned) tx that the browser
 * completes locally before submitting.
 */
export async function registerExecutorRoutes(app: FastifyInstance) {
  const tags = ["Executor"];

  const relayerKeypair = loadKeypair(RELAYER_KEYPAIR_PATH);
  const executor = new ExecutorService({
    rpcUrl: RPC_URL,
    relayerKeypair,
    executorProgramId: new PublicKey(EXECUTOR_PROGRAM_ID),
  });
  const controller = createExecutorController(executor);

  app.post("/executor/setup-pair", { schema: { tags } }, controller.setupPair);
  app.post("/executor/mint-tokens", { schema: { tags } }, controller.mintTokens);
  app.post("/executor/init-position-tx", { schema: { tags } }, controller.initPositionTx);
  app.post("/executor/add-liquidity-tx", { schema: { tags } }, controller.addLiquidityTx);
  app.post("/executor/withdraw-close-tx", { schema: { tags } }, controller.withdrawCloseTx);
  app.get("/executor/position-authority", { schema: { tags } }, controller.positionAuthority);
}

function loadKeypair(path: string): Keypair {
  const raw = readFileSync(path, "utf-8");
  const bytes = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(bytes);
}
