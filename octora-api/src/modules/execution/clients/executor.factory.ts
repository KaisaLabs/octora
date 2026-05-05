import { Connection, Keypair } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import type { AppConfig } from "#common/config";
import type { MeteoraExecutor } from "./meteora-executor.js";
import { createMockMeteoraExecutor } from "./mock-meteora.executor.js";
import { OctoraExecutorClient } from "./octora-executor.client.js";
import { createOnchainMeteoraExecutor } from "./onchain-meteora.executor.js";

/**
 * Pick a `MeteoraExecutor` implementation based on `config.useOnchainExecutor`.
 *
 * Default (flag off): `MockMeteoraExecutor` — the existing behaviour. Tests
 * and local dev keep working unchanged.
 *
 * Flag on: `OnchainMeteoraExecutor` wrapping a real `OctoraExecutorClient`
 * pointed at `config.executorRpcUrl` and signed by the keypair at
 * `config.executorRelayerKeypairPath`. The bridge currently throws on
 * LP-flow methods (see onchain-meteora.executor.ts) — useful for catching
 * mock-only callers in staging without falling back silently.
 */
export function createMeteoraExecutorFromConfig(config: AppConfig): MeteoraExecutor {
  if (!config.useOnchainExecutor) {
    return createMockMeteoraExecutor();
  }

  const connection = new Connection(config.executorRpcUrl, "confirmed");
  const relayerKeypair = loadKeypair(config.executorRelayerKeypairPath);
  const programId = new PublicKey(config.executorProgramId);

  const client = new OctoraExecutorClient({
    connection,
    relayerKeypair,
    programId,
  });

  return createOnchainMeteoraExecutor(client);
}

function loadKeypair(path: string): Keypair {
  const raw = readFileSync(path, "utf-8");
  const bytes = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(bytes);
}
