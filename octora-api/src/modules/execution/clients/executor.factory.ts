import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import type { AppConfig } from "#common/config";
import type { SolanaChain } from "#common/solana/chain";
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
 * pulled off the provided `SolanaChain` (the executor-submit chain in
 * app.ts) and signed by the keypair at `config.executorRelayerKeypairPath`.
 * The bridge currently throws on LP-flow methods (see
 * onchain-meteora.executor.ts) — useful for catching mock-only callers
 * in staging without falling back silently.
 */
export function createMeteoraExecutorFromConfig(
  config: AppConfig,
  chain: SolanaChain,
): MeteoraExecutor {
  if (!config.useOnchainExecutor) {
    return createMockMeteoraExecutor();
  }

  const relayerKeypair = loadKeypair(config.executorRelayerKeypairPath);
  const programId = new PublicKey(config.executorProgramId);

  const client = new OctoraExecutorClient({
    // OctoraExecutorClient still consumes a raw Connection (the
    // existing test harness fakes one in-process); pull it from the
    // chain seam at the call site rather than building a fresh one.
    connection: chain.rawConnection(),
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
