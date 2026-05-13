-- Phase 3 P0: index for beta-cap aggregate.
--
-- `sumActiveAmountSol()` filters by `state NOT IN ('completed','failed')`
-- and aggregates `amount::numeric`. A partial B-tree on `(state)` excluding
-- terminal rows keeps the index small and lets Postgres skip the terminal
-- bulk entirely when the table grows past beta caps. CONCURRENTLY avoids
-- an ACCESS EXCLUSIVE lock on production traffic.
--
-- The same index also serves `countActiveByWallet` once the planner
-- considers the partial predicate matching `terminalFilter`.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Position_active_idx"
  ON "Position" ("state")
  WHERE "state" NOT IN ('completed', 'failed');
