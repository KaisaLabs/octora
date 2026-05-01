import type { PrismaClient } from "@prisma/client";

export interface WaitlistRepository {
  add(email: string, source?: string): Promise<{ id: string; email: string; createdAt: Date }>;
  exists(email: string): Promise<boolean>;
}

export function createPrismaWaitlistRepository(client: PrismaClient): WaitlistRepository {
  return {
    async add(email, source) {
      return client.waitlist.create({ data: { email, source } });
    },
    async exists(email) {
      const entry = await client.waitlist.findUnique({ where: { email } });
      return entry !== null;
    },
  };
}
