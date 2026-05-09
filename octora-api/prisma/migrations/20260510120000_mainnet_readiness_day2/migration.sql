-- Mainnet-readiness Day 2: walletAddress on positions, beta gate,
-- one-time auth nonces, persistent mixer root-seen state.
--
-- Position.walletAddress is added NOT NULL with no default. Empty/dev
-- databases migrate cleanly; if any rows exist, this will fail and the
-- operator must either backfill or drop. That's intentional — we don't
-- want silently-NULL wallet rows masquerading as authenticated positions.

-- AlterTable
ALTER TABLE "Position" ADD COLUMN "walletAddress" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "Position_walletAddress_idx" ON "Position"("walletAddress");

-- CreateIndex
CREATE INDEX "Position_walletAddress_state_idx" ON "Position"("walletAddress", "state");

-- CreateTable
CREATE TABLE "BetaAccess" (
    "walletAddress" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "BetaAccess_pkey" PRIMARY KEY ("walletAddress")
);

-- CreateTable
CREATE TABLE "AuthNonce" (
    "nonce" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthNonce_pkey" PRIMARY KEY ("nonce")
);

-- CreateIndex
CREATE INDEX "AuthNonce_walletAddress_used_idx" ON "AuthNonce"("walletAddress", "used");

-- CreateIndex
CREATE INDEX "AuthNonce_expiresAt_idx" ON "AuthNonce"("expiresAt");

-- CreateTable
CREATE TABLE "MixerRootSeen" (
    "root" TEXT NOT NULL,
    "firstSeenSlot" BIGINT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MixerRootSeen_pkey" PRIMARY KEY ("root")
);

-- CreateIndex
CREATE INDEX "MixerRootSeen_firstSeenAt_idx" ON "MixerRootSeen"("firstSeenAt");
