import type { FastifyInstance } from "fastify";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { ExecutorService } from "./executor.service.js";
import { createExecutorController } from "./executor.controller.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

export interface ExecutorRoutesOptions {
  executorProgramId: string;
  relayerKeypairPath: string;
}

/**
 * Test-page executor routes. These power the integrated test page:
 * /executor/setup-pair (server admin), /executor/init-position-tx,
 * /executor/add-liquidity-tx, /executor/withdraw-close-tx.
 *
 * Stealth keypair signatures NEVER touch the server — every tx-building
 * endpoint returns a partially-signed (or unsigned) tx that the browser
 * completes locally before submitting.
 */
export async function registerExecutorRoutes(
  app: FastifyInstance,
  opts: ExecutorRoutesOptions,
) {
  const tags = ["Executor"];

  const relayerKeypair = loadKeypair(opts.relayerKeypairPath);
  const executor = new ExecutorService({
    rpcUrl: RPC_URL,
    relayerKeypair,
    executorProgramId: new PublicKey(opts.executorProgramId),
  });
  const controller = createExecutorController(executor);

  app.post("/executor/setup-pair", { schema: { tags } }, controller.setupPair);
  app.post("/executor/mint-tokens", { schema: { tags } }, controller.mintTokens);
  app.post("/executor/init-position-tx", { schema: { tags } }, controller.initPositionTx);
  app.post("/executor/add-liquidity-tx", { schema: { tags } }, controller.addLiquidityTx);
  app.post("/executor/claim-fees-tx", { schema: { tags } }, controller.claimFeesTx);
  app.post("/executor/withdraw-close-tx", { schema: { tags } }, controller.withdrawCloseTx);
  app.post("/executor/dlmm-swap-tx", { schema: { tags } }, controller.dlmmSwapTx);
  app.get("/executor/pool-authority", { schema: { tags } }, controller.poolAuthority);
  app.get("/executor/devnet-pools", { schema: { tags } }, controller.devnetPools);
  app.post("/executor/use-pool", { schema: { tags } }, controller.usePool);
  app.get("/executor/position-state", { schema: { tags } }, controller.positionState);
}

function loadKeypair(path: string): Keypair {
  const raw = readFileSync(path, "utf-8");
  const bytes = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(bytes);
}
