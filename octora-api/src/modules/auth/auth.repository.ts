import type { PrismaClient } from "@prisma/client";

/**
 * Persistence surface for the wallet-signature auth flow. Keeping Prisma
 * out of `common/auth.ts` means the auth preHandlers depend on an
 * interface — easier to fake, and the only place SQL knowledge lives
 * is here.
 */
export interface AuthRepository {
  /** Persist a freshly-issued nonce. Caller computes `expiresAt`. */
  createNonce(input: { nonce: string; walletAddress: string; expiresAt: Date }): Promise<void>;

  /**
   * Best-effort GC of nonces whose `expiresAt` is older than `olderThan`.
   * Swallows errors — the cleanup is opportunistic, never load-bearing.
   */
  pruneExpiredNonces(olderThan: Date): Promise<void>;

  /**
   * Atomically claim a presented nonce by flipping `used = true` if it
   * matches the wallet, is unused, and is not yet expired. Returns true
   * iff exactly one row was updated. Two concurrent requests presenting
   * the same nonce can never both succeed.
   */
  claimNonce(input: { nonce: string; walletAddress: string; now: Date }): Promise<boolean>;

  /** True iff `walletAddress` appears in the BetaAccess allow-list. */
  walletHasBetaAccess(walletAddress: string): Promise<boolean>;
}

export function createPrismaAuthRepository(prisma: PrismaClient): AuthRepository {
  return {
    async createNonce({ nonce, walletAddress, expiresAt }) {
      await prisma.authNonce.create({ data: { nonce, walletAddress, expiresAt } });
    },
    async pruneExpiredNonces(olderThan) {
      await prisma.authNonce
        .deleteMany({ where: { expiresAt: { lt: olderThan } } })
        .catch(() => {});
    },
    async claimNonce({ nonce, walletAddress, now }) {
      const result = await prisma.authNonce.updateMany({
        where: { nonce, walletAddress, used: false, expiresAt: { gt: now } },
        data: { used: true },
      });
      return result.count === 1;
    },
    async walletHasBetaAccess(walletAddress) {
      const row = await prisma.betaAccess.findUnique({ where: { walletAddress } });
      return row != null;
    },
  };
}
