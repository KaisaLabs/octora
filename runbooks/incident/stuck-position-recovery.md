# Incident: stuck position recovery (P1-45)

**Status:** Triage runbook for positions stalled in a non-terminal state past their normal SLA.
**Last updated:** 2026-05-10.

## What "stuck" means here

A position is stuck when it's been in a non-terminal state longer than the recovery worker's threshold and the worker hasn't advanced it. Each state has its own SLA:

| State | Worker threshold | What "stuck" implies |
| --- | --- | --- |
| `awaiting_signature` | n/a (user-side wait) | The user opened an intent but never signed; not actionable. |
| `funding_in_progress` | 5min | Privacy-adapter handoff failed silently. |
| `executing_on_meteora` | 5min | Meteora CPI tx didn't land. Worker checks via `getSignatureStatus`. |
| `indexing` | 2min | Final snapshot didn't arrive. Worker re-reconciles. |
| `claiming` / `withdrawing` / `closing` | n/a (worker only handles 2 states today) | Manual triage. |

The recovery worker (P1-29) handles `executing_on_meteora` and `indexing` automatically. This runbook covers everything else, plus the cases where the worker itself is failing.

## 0. Triage decision tree

```
Page received? ───┐
                  ├─▶ "PositionFailed (ID: ...)" (recovery-worker capture)
                  │      └─▶ §3 Failed-state forensics
                  │
                  ├─▶ User reports stuck position
                  │      └─▶ §1 Confirm + classify
                  │
                  └─▶ Recovery worker silent for >10min
                         └─▶ §4 Worker health
```

## 1. Confirm and classify

```bash
# Pull every non-terminal position older than 5 min.
psql $DATABASE_URL -c "
  SELECT id, walletAddress, state, action, updatedAt
    FROM \"Position\"
    WHERE state NOT IN ('completed','failed','draft')
      AND updatedAt < NOW() - INTERVAL '5 minutes'
    ORDER BY updatedAt ASC;
"
```

For the affected position, also pull:

```bash
psql $DATABASE_URL -c "
  SELECT id, state, failureStage, updatedAt
    FROM \"ExecutionSession\"
    WHERE positionId = '<POSITION_ID>'
    ORDER BY createdAt DESC LIMIT 5;

  SELECT signature, createdAt, updatedAt
    FROM \"PositionReconciliation\"
    WHERE positionId = '<POSITION_ID>';
"
```

Classify into one of these buckets:

- **A. Has a venue signature** — go to §2.
- **B. No signature, state = `executing_on_meteora`** — go to §2 (treat as failed).
- **C. State = `funding_in_progress`** — privacy adapter regressed. Page the on-call dev; advance via §5.
- **D. State = `indexing`** — go to §6.
- **E. State = `claiming` / `withdrawing` / `closing`** — go to §7.

## 2. Verify the on-chain venue tx

```bash
solana confirm <SIGNATURE>
solana transaction-history <STEALTH_PUBKEY> --limit 5
```

- `Finalized` with no `err` → tx landed; the indexer just hasn't caught up. Force-advance via §6.
- `Failed` with an instruction error → real failure. Read the error code; if it's a slippage / Meteora-side error, treat as user-recoverable. Otherwise page the on-call dev.
- Signature unknown to the cluster → the tx was dropped. Move to §5 to fail-close.

## 3. Failed-state forensics

The recovery worker fires `captureException` once per newly-failed position. If you got here from a Sentry page:

```bash
# Pull every failure in the last hour.
psql $DATABASE_URL -c "
  SELECT id, walletAddress, action, state, updatedAt
    FROM \"Position\"
    WHERE state = 'failed' AND updatedAt > NOW() - INTERVAL '1 hour'
    ORDER BY updatedAt DESC;

  SELECT positionId, failureStage, updatedAt
    FROM \"ExecutionSession\"
    WHERE state = 'failed' AND updatedAt > NOW() - INTERVAL '1 hour';
"
```

Cross-check the `failureStage` distribution against the `recoveryCatalog` in `octora-api/src/domain` — a sudden cluster of one stage (e.g. `venue-confirmation`) is the signal that an upstream regression hit production. Pause if in doubt (see `mixer-pause.md`).

## 4. Worker health

If multiple positions are stuck across types and the worker hasn't advanced anything in >10 min, the worker itself is the issue. Check:

- `app.log` for lines with prefix `recovery:`. The tick log has `executingChecked / executingAdvanced / indexingAdvanced / failuresAlerted`.
- Confirm `/health.rpc.ok` is true (the worker calls `getSignatureStatus`; if RPC is down, recovery stalls).
- Confirm `OCTORA_RECOVERY_WORKER_ENABLED` isn't set to `false` (intentional disable for an incident — should have been temporary).

If the worker is healthy but slow, raise its concurrency (current default is sequential). Implementation lives at `octora-api/src/modules/positions/recovery-worker.ts`.

## 5. Manually fail a stuck position

When a position has been stuck past SLA AND the venue tx is confirmed-failed or dropped, force-close:

```bash
psql $DATABASE_URL <<SQL
BEGIN;
UPDATE "Position"
   SET state = 'failed', updatedAt = NOW()
 WHERE id = '<POSITION_ID>';
UPDATE "ExecutionSession"
   SET state = 'failed', failureStage = 'recovery-required', updatedAt = NOW()
 WHERE positionId = '<POSITION_ID>'
   AND id = (SELECT id FROM "ExecutionSession"
              WHERE positionId = '<POSITION_ID>'
              ORDER BY createdAt DESC LIMIT 1);
INSERT INTO "Activity" (id, positionId, action, state, headline, detail, safeNextStep, createdAt)
  VALUES (gen_random_uuid(), '<POSITION_ID>', 'add-liquidity', 'failed',
          'Manual recovery — operator force-closed',
          'On-call confirmed the venue tx <SIG> failed/dropped on chain. Refund flow next.',
          'contact-support', NOW());
COMMIT;
SQL
```

Then DM the user (via the wallet email if they're on the waitlist) with a short note. Operator action; don't automate this.

## 6. Force the indexer to advance an `indexing` position

If you've confirmed the venue tx is finalized but the worker hasn't moved the position to `active`:

```bash
# Inspect the reconciliation row.
psql $DATABASE_URL -c "SELECT * FROM \"PositionReconciliation\" WHERE positionId = '<ID>';"

# If signature is NULL, the indexer never received the snapshot. Manually
# stamp it and let the next worker tick advance the position.
psql $DATABASE_URL -c "
  UPDATE \"PositionReconciliation\"
     SET signature = '<VERIFIED_FINALIZED_SIG>', updatedAt = NOW()
   WHERE positionId = '<ID>';"
```

Wait one worker tick (≤30s). Confirm the position state advances to `active`.

## 7. `claiming` / `withdrawing` / `closing` stuck

These three lifecycle states aren't covered by the worker today. Manual procedure:

1. Pull the latest `ExecutionSession.state` for the position.
2. Check the on-chain stealth wallet balance — has the claim / withdraw landed?
3. If yes, advance the position state directly (use the §5 SQL pattern with state=`completed`).
4. If no, page the on-call dev — the executor's lifecycle CPI didn't land, which is a code-path regression.

Add a dedicated branch for these states to the recovery worker as a P3 follow-up. The audit prioritises the `executing_on_meteora` and `indexing` buckets because those represent the longest user-visible lag.

## 8. After-action

- For every manually-recovered position, file a one-line entry in the deploy ticket: `<position-id> · <reason> · <operator>`.
- For any cluster of stuck positions (>3 with the same `failureStage` in 24h), open an incident issue and treat as a regression.
- If a runbook step was unclear, update this file in the same PR that fixes the regression.
