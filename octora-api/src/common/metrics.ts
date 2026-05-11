import { Connection, PublicKey } from "@solana/web3.js";
import type { PrismaClient } from "@prisma/client";

import type { AppConfig } from "./config";
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
  prisma: PrismaClient,
  config: AppConfig,
): Promise<MetricsSnapshot> {
  const [mixer, positions] = await Promise.all([
    collectMixer(config).catch(() => null),
    collectPositions(prisma),
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

async function collectPositions(prisma: PrismaClient): Promise<PositionMetrics> {
  const grouped = await prisma.position.groupBy({ by: ["state"], _count: { _all: true } });
  const byState: Record<string, number> = {};
  for (const row of grouped) {
    byState[row.state] = row._count._all;
  }

  const terminal = new Set(["completed", "failed"]);
  const activeStates = Object.keys(byState).filter((s) => !terminal.has(s));
  const activeCount = activeStates.reduce((sum, s) => sum + (byState[s] ?? 0), 0);

  // Same JS-side reduce pattern the position repository uses for the
  // beta-cap math. Bounded by the active position count — fine at beta
  // scale, replace with a SUM materialised view if it ever isn't.
  const active = await prisma.position.findMany({
    where: { state: { notIn: ["completed", "failed"] } },
    select: { amount: true },
  });
  let activeTvlSol = 0;
  for (const row of active) {
    const v = Number(row.amount);
    if (Number.isFinite(v)) activeTvlSol += v;
  }

  return { byState, activeCount, activeTvlSol };
}
