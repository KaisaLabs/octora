import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { loadConfig } from "#common/config";

/**
 * Build a Prisma client backed by an explicitly-sized `pg.Pool`.
 *
 * Defaults come from `loadConfig().dbPool`:
 *   - `max` / `min` / `idleTimeoutMs` size the connection pool.
 *   - `statementTimeoutMs` (when > 0) is applied as a session-level
 *     `SET statement_timeout` on every new connection. Any single
 *     statement exceeding it is aborted by Postgres — a hard cap against
 *     a runaway query stalling a serverless invocation.
 *
 * **PgBouncer note:** in `transaction` mode named prepared statements
 * are forbidden; the Prisma pg-adapter avoids them by default, but the
 * `OCTORA_DB_PGBOUNCER_MODE` env var documents the upstream pooler so a
 * future change here can audit against it. In `session` mode there is
 * no extra constraint; with `none` we talk directly to Postgres.
 */
export function createPrismaClient(connectionString?: string): PrismaClient {
  const { databaseUrl, dbPool } = loadConfig();
  const pool = new Pool({
    connectionString: connectionString ?? databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: dbPool.max,
    min: dbPool.min,
    idleTimeoutMillis: dbPool.idleTimeoutMs,
  });

  if (dbPool.statementTimeoutMs > 0) {
    const timeout = dbPool.statementTimeoutMs;
    pool.on("connect", (client) => {
      // Fire-and-forget: Postgres applies the setting for the session. If
      // it ever fails (it shouldn't), the connection is already past the
      // point where we could abort it cleanly.
      void client.query(`SET statement_timeout = ${timeout}`);
    });
  }

  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}
