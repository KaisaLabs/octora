import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

export function createPrismaClient(connectionString?: string): PrismaClient {
  const pool = new Pool({ connectionString: connectionString ?? process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}
