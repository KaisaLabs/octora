import { existsSync, readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";

import type { AppConfig } from "./config";
import { pingDatabase } from "./db/health.js";
import { MIXER_POOL_IS_PAUSED_OFFSET } from "../modules/mixer/layout.js";

/**
 * Minimal connectivity surface health checks need. The real
 * implementation in production is `pingDatabase` from `common/db/`,
 * which wraps Prisma. Keeping the dependency to a function reference
 * (rather than a full PrismaClient) means health.ts never has to know
 * about the ORM at all.
 */
export type DatabasePinger = () => ReturnType<typeof pingDatabase>;

export interface HealthCheck {
  ok: boolean;
  /** Human-readable failure reason; `undefined` when `ok`. */
  detail?: string;
  /** Latency of the probe in ms (best-effort). */
  latencyMs?: number;
}

export interface HealthReport {
  status: "ok" | "degraded";
  checks: {
    db: HealthCheck;
    rpc: HealthCheck;
    relayer: HealthCheck;
    mixer: HealthCheck;
  };
}

const RPC_TIMEOUT_MS = 2_000;
const MIXER_POOL_SEED = Buffer.from("mixer_pool");

/**
 * Run the full liveness/readiness probe. Returns 200 when every check
 * passes, 503 otherwise — orchestrators (Fly machines, ECS, K8s) and
 * uptime monitors gate traffic on this exact behavior.
 *
 * Checks:
 *   - `db`     — `SELECT 1` round-trip via Prisma
 *   - `rpc`    — `getSlot()` within {@link RPC_TIMEOUT_MS}
 *   - `relayer`— relayer keypair file readable + parseable as a 64-byte secret
 *   - `mixer`  — on-chain `MixerPool` account fetched + `is_paused === false`
 */
export async function runHealthCheck(
  pingDb: DatabasePinger,
  config: AppConfig,
): Promise<HealthReport> {
  const [db, rpc, relayer, mixer] = await Promise.all([
    checkDatabase(pingDb),
    checkRpc(config.executorRpcUrl),
    checkRelayerKeypair(config.executorRelayerKeypairPath),
    checkMixer(config),
  ]);

  const ok = db.ok && rpc.ok && relayer.ok && mixer.ok;
  return {
    status: ok ? "ok" : "degraded",
    checks: { db, rpc, relayer, mixer },
  };
}

async function checkDatabase(pingDb: DatabasePinger): Promise<HealthCheck> {
  const result = await pingDb();
  if (result.ok) return { ok: true, latencyMs: result.latencyMs };
  return { ok: false, detail: result.detail, latencyMs: result.latencyMs };
}

async function checkRpc(rpcUrl: string): Promise<HealthCheck> {
  const t0 = Date.now();
  try {
    const connection = new Connection(rpcUrl, "confirmed");
    const slot = await Promise.race([
      connection.getSlot("confirmed"),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`RPC getSlot timed out after ${RPC_TIMEOUT_MS}ms`)),
          RPC_TIMEOUT_MS,
        ),
      ),
    ]);
    return { ok: slot > 0, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - t0,
    };
  }
}

function checkRelayerKeypair(keypairPath: string): HealthCheck {
  if (!keypairPath) {
    return { ok: false, detail: "executorRelayerKeypairPath is empty" };
  }
  if (!existsSync(keypairPath)) {
    return { ok: false, detail: `keypair not found at ${keypairPath}` };
  }
  try {
    const raw = readFileSync(keypairPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 64) {
      return {
        ok: false,
        detail: `keypair JSON must be a 64-byte array; got length ${
          Array.isArray(parsed) ? parsed.length : typeof parsed
        }`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkMixer(config: AppConfig): Promise<HealthCheck> {
  const t0 = Date.now();
  try {
    const programId = new PublicKey(config.mixerProgramId);
    const denomBytes = Buffer.alloc(8);
    denomBytes.writeBigUInt64LE(config.mixerDenomination);
    const [poolPda] = PublicKey.findProgramAddressSync(
      [MIXER_POOL_SEED, denomBytes],
      programId,
    );

    const connection = new Connection(config.executorRpcUrl, "confirmed");
    const accountInfo = await Promise.race([
      connection.getAccountInfo(poolPda),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`mixer pool fetch timed out after ${RPC_TIMEOUT_MS}ms`)),
          RPC_TIMEOUT_MS,
        ),
      ),
    ]);

    if (!accountInfo) {
      return {
        ok: false,
        detail: `MixerPool account ${poolPda.toBase58()} not found — pool not initialized`,
        latencyMs: Date.now() - t0,
      };
    }

    // Layout offsets live in octora-api/src/modules/mixer/layout.ts.
    const isPaused = accountInfo.data[MIXER_POOL_IS_PAUSED_OFFSET] === 1;
    if (isPaused) {
      return {
        ok: false,
        detail: "MixerPool.is_paused = true",
        latencyMs: Date.now() - t0,
      };
    }
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - t0,
    };
  }
}
