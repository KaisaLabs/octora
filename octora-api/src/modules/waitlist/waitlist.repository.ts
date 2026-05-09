import type { PrismaClient } from "@prisma/client";

export interface WaitlistRepository {
  add(email: string, source?: string): Promise<{ id: string; email: string; createdAt: Date }>;
  exists(email: string): Promise<boolean>;
  /** True when the wallet has been admitted to the beta cohort. */
  isApproved(walletAddress: string): Promise<boolean>;
  /**
   * Admin-only: idempotently mark a wallet as beta-approved. Re-approving
   * an existing wallet updates `note` but leaves `approvedAt` unchanged.
   */
  approveWallet(walletAddress: string, note?: string): Promise<{ walletAddress: string; approvedAt: Date }>;
  /** Admin-only: revoke beta access (e.g., after abuse). */
  revokeWallet(walletAddress: string): Promise<boolean>;
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
    async isApproved(walletAddress) {
      const entry = await client.betaAccess.findUnique({ where: { walletAddress } });
      return entry !== null;
    },
    async approveWallet(walletAddress, note) {
      const row = await client.betaAccess.upsert({
        where: { walletAddress },
        update: note !== undefined ? { note } : {},
        create: { walletAddress, note: note ?? null },
      });
      return { walletAddress: row.walletAddress, approvedAt: row.approvedAt };
    },
    async revokeWallet(walletAddress) {
      const removed = await client.betaAccess.deleteMany({ where: { walletAddress } });
      return removed.count > 0;
    },
  };
}
