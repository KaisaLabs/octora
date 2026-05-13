import type { PrismaClient } from "@prisma/client";

/**
 * Cheap connectivity probe — `SELECT 1` round-trip. Returns the latency
 * in ms on success or the error detail on failure. Used by `/health`.
 *
 * Lives in `common/db/` so the rest of the API never imports
 * `@prisma/client` directly; everything DB-shaped goes through this
 * folder or a `*.repository.ts`.
 */
export async function pingDatabase(
  prisma: PrismaClient,
): Promise<{ ok: true; latencyMs: number } | { ok: false; detail: string; latencyMs: number }> {
  const t0 = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - t0,
    };
  }
}
