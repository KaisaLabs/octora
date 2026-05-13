import { Connection, PublicKey } from "@solana/web3.js";

import type { AppConfig } from "./config";
import type { PositionRepository } from "#modules/positions/position.repository";
import { TERMINAL_POSITION_STATES } from "#modules/positions/position.repository";
import {
  MIXER_POOL_IS_PAUSED_OFFSET,
  MIXER_POOL_NEXT_LEAF_INDEX_OFFSET,
} from "../modules/mixer/layout.js";

/**
 * Operational metrics endpoint (P1-44).
 *
 * The audit baseline calls for: mixer TVL, relayer hot-wallet balance,
 * position state distribution, and withdrawal success rate. We surface
 * the same shape as JSON so monitoring tools (UptimeRobot custom
 * checks, Datadog OpenMetrics scrape, Grafana JSON datasource) can
 * consume it without a Prometheus exporter dep.
 *
 * Returned as a single object so the response stays cheap to fetch
 * even when monitors poll on a 30s cadence.
 */
export interface MetricsSnapshot {
  /** Wall-clock at metric collection (ISO-8601). */
  collectedAt: string;
  /** Process uptime in seconds. */
  uptimeSeconds: number;
  mixer: MixerMetrics | null;
  positions: PositionMetrics;
}

export interface MixerMetrics {
  /** Mixer pool PDA (base58). */
  poolAddress: string;
  /** Pool SOL balance in lamports as a decimal string. */
  balanceLamports: string;
  /** Number of leaves inserted into the Merkle tree so far. */
  nextLeafIndex: number;
  /** True when the on-chain emergency pause is engaged. */
  isPaused: boolean;
}

export interface PositionMetrics {
  /** Count by `state` column. */
  byState: Record<string, number>;
  /** Total active (non-terminal) positions. */
  activeCount: number;
  /** Sum of `amount` (SOL) across active positions. */
  activeTvlSol: number;
}

const MIXER_POOL_SEED = Buffer.from("mixer_pool");

/** Build a one-shot snapshot. Reads on-chain mixer state + DB position state. */
export async function collectMetrics(
  positionRepo: PositionRepository,
  config: AppConfig,
): Promise<MetricsSnapshot> {
  const [mixer, positions] = await Promise.all([
    collectMixer(config).catch(() => null),
    collectPositions(positionRepo),
  ]);
  return {
    collectedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    mixer,
    positions,
  };
}

async function collectMixer(config: AppConfig): Promise<MixerMetrics | null> {
  const programId = new PublicKey(config.mixerProgramId);
  const denomBytes = Buffer.alloc(8);
  denomBytes.writeBigUInt64LE(config.mixerDenomination);
  const [poolPda] = PublicKey.findProgramAddressSync([MIXER_POOL_SEED, denomBytes], programId);

  const connection = new Connection(config.executorRpcUrl, "confirmed");
  const accountInfo = await connection.getAccountInfo(poolPda);
  if (!accountInfo) return null;

  const balance = await connection.getBalance(poolPda);

  // Layout offsets live in octora-api/src/modules/mixer/layout.ts.
  const data = accountInfo.data;
  const nextLeafIndex = data.readUInt32LE(MIXER_POOL_NEXT_LEAF_INDEX_OFFSET);
  const isPaused = data[MIXER_POOL_IS_PAUSED_OFFSET] === 1;

  return {
    poolAddress: poolPda.toBase58(),
    balanceLamports: balance.toString(),
    nextLeafIndex,
    isPaused,
  };
}

async function collectPositions(positionRepo: PositionRepository): Promise<PositionMetrics> {
  const [byState, activeTvlSol] = await Promise.all([
    positionRepo.countByState(),
    positionRepo.sumActiveAmountSol(),
  ]);

  const terminal = new Set<string>(TERMINAL_POSITION_STATES);
  const activeCount = Object.entries(byState).reduce(
    (sum, [state, count]) => (terminal.has(state) ? sum : sum + count),
    0,
  );

  return { byState, activeCount, activeTvlSol };
}
