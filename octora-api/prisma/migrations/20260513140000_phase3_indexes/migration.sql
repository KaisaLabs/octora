-- Phase 3 rest: scalability indexes.
--
-- Recovery-worker scan path (`findStuckPositions`) filters by
-- `state` + `updatedAt < cutoff`. The existing `Position_active_idx` is a
-- partial state-only index — adequate for `sumActiveAmountSol` but forces
-- a recheck against the heap for the time-window predicate. This
-- composite gives the planner both keys without the heap fetch.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Position_state_updatedAt_idx"
  ON "Position" ("state", "updatedAt");

-- ExecutionSession failure triage: admin endpoints and the recovery
-- worker look up sessions by `(state, failureStage)` to diagnose stuck
-- positions. The table is small today but grows linearly with execution
-- attempts, so a dedicated index keeps the lookup constant-time.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ExecutionSession_state_failureStage_idx"
  ON "ExecutionSession" ("state", "failureStage");

-- Note: `PositionReconciliation(positionId)` is intentionally omitted —
-- `positionId` is the table's primary key, so Postgres already maintains
-- a unique B-tree on it. Any explicit `@@index([positionId])` would be
-- redundant and waste write throughput. The Phase 3 plan called for it
-- but the schema already covers it.
