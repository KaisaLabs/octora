import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { loadConfig } from "#common/config";

export function createPrismaClient(connectionString?: string): PrismaClient {
  const pool = new Pool({
    connectionString: connectionString ?? loadConfig().databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}
