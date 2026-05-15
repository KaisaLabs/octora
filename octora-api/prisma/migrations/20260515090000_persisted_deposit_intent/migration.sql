-- Persisted Deposit Intent table for the two-phase Private Deposit ->
-- Position Open flow (dust/03 + ADR-0004). The backend writes one row
-- per Position on `DEPOSITED`, clears it on `LP_DONE` or `WITHDRAWN`.
-- Keyed by nullifierHash because the user holds the preimage off-chain;
-- positionId carries a unique constraint so the aggregate can clear by
-- positionId without re-resolving the nullifier hash.
CREATE TABLE "PersistedDepositIntent" (
  "nullifierHash" TEXT NOT NULL,
  "positionId"    TEXT NOT NULL,
  "commitment"    TEXT NOT NULL,
  "intendedPool"  TEXT NOT NULL,
  "denom"         TEXT NOT NULL,
  "expiresAt"     TIMESTAMP(3) NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PersistedDepositIntent_pkey" PRIMARY KEY ("nullifierHash")
);

CREATE UNIQUE INDEX "PersistedDepositIntent_positionId_key"
  ON "PersistedDepositIntent" ("positionId");

-- Partial-scan friendly index for the eventual TTL pruner (out of scope
-- for dust/03; recorded so the index is in place when dust/04 wires the
-- cleanup worker that drops expired intents past the funding TTL).
CREATE INDEX "PersistedDepositIntent_expiresAt_idx"
  ON "PersistedDepositIntent" ("expiresAt");
