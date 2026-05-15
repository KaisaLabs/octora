# Incident: database restore (P1-45)

**Status:** Authoritative procedure for restoring the production Postgres from backup.
**Last updated:** 2026-05-10.
**Drill cadence:** monthly.

## When to restore

- Accidental destructive query against prod (the `DROP TABLE`, the `DELETE FROM Position WHERE 1=1`).
- Postgres data corruption — rows return 500s on Prisma reads, or the query planner reports an internal error.
- Disk failure on the Postgres VM with no replication target.
- Suspicious admin activity that may have tampered with `BetaAccess` / `AuthNonce` / `Position` rows.

If the production DB is **completely down** (TCP refuses), this runbook still applies — the restore target can be a fresh VM.

## Backup posture

The audit (P2-32) recommends managed Postgres with point-in-time recovery (RDS / Supabase / Neon). Until that's in place, the beta runs on:

| Layer | Cadence | Retention | Owner |
| --- | --- | --- | --- |
| `pg_dump` snapshot to S3 | every 6h | 30 days | API host cron |
| WAL archive to S3 | continuous (5min) | 7 days | API host cron |
| Off-host snapshot copy | nightly | 7 days | Backup VM |

These cron jobs live in `/etc/cron.d/octora-postgres-backup`. If they're not there yet, **stand them up before the restore drill is meaningful** — see `runbooks/PRODUCTION_READINESS.md` P2-32 task. A backup script in the repo (`scripts/backup-postgres.sh`) is provided as a reference; production should run a battle-tested tool like `wal-g` or `barman`.

## 0. Pre-flight

- [ ] Confirm the incident type: data corruption, accidental delete, or hardware failure.
- [ ] Verify the most recent successful backup. The S3 bucket dashboard shows the latest object timestamp.
- [ ] Open `#inc-octora-db-YYYYMMDD-<slug>` in Slack. Page on-call.
- [ ] Decide the **target restore time** — the timestamp the API should see when it comes back up. Default: most recent backup before the incident started.
- [ ] **Pause writes** to prevent users from layering more state on top of a corrupted DB:
  ```bash
  ssh prod "docker compose stop octora-api"
  ```
  Reads continue to fail with 502 from Caddy, which is acceptable for a 30-min restore window.

## 1. Decide point-in-time vs snapshot

| Scenario | Use | Notes |
| --- | --- | --- |
| Accidental query 5 min ago | PITR (WAL replay) | Restore the last full snapshot, replay WAL up to T-1min before the bad query. |
| Corruption noticed an hour ago | PITR | Same idea, larger replay window. |
| Hardware failure | Snapshot only | Most recent snapshot, accept whatever data lag that implies. |
| Tampered admin rows | Snapshot only | A trusted snapshot is the only safe baseline; the WAL since then may include the tampering. |

## 2. Restore

### 2a. Snapshot only

```bash
# On a clean Postgres host (the prod host or a fresh VM):
sudo systemctl stop postgresql

# Pull the snapshot.
aws s3 cp s3://octora-backup/postgres/<TIMESTAMP>.dump ./restore.dump

# Drop & recreate the database.
sudo -u postgres psql -c "DROP DATABASE octora;"
sudo -u postgres psql -c "CREATE DATABASE octora OWNER octora;"

# Restore.
sudo -u postgres pg_restore --no-owner --dbname=octora ./restore.dump

sudo systemctl start postgresql
```

### 2b. Point-in-time recovery

PITR requires the snapshot + WAL chain. The exact commands depend on the tool (`wal-g`, `pg_basebackup` + `pg_walreplay`, managed-DB UI). The shape:

```bash
# Stage the snapshot as the base.
wal-g backup-fetch /var/lib/postgresql/16/main LATEST

# Configure recovery target.
cat > /var/lib/postgresql/16/main/recovery.signal <<EOF
recovery_target_time = '2026-05-10 14:32:00 UTC'
restore_command = 'wal-g wal-fetch %f %p'
EOF

sudo systemctl start postgresql
# Postgres replays WAL until the target, then promotes.
```

If you're on a managed DB, use the provider's UI. RDS: *Restore to Point in Time*. Supabase: *Project Settings → Database → PITR*. Neon: *Branches → Restore from history*.

## 3. Verify the restored DB

```bash
psql $DATABASE_URL -c "SELECT count(*) FROM \"Position\";"
psql $DATABASE_URL -c "SELECT count(*) FROM \"BetaAccess\";"
psql $DATABASE_URL -c "SELECT count(*) FROM \"MixerRootSeen\";"

# Check the most recent rows match expectations:
psql $DATABASE_URL -c "
  SELECT id, state, updatedAt
    FROM \"Position\"
   ORDER BY updatedAt DESC LIMIT 10;"
```

If the row counts are wildly off from what you remember pre-incident, **stop**. Restore the next-older snapshot and try again.

## 4. Reconcile with on-chain state

The mixer's authoritative state is on-chain (`MixerPool.next_leaf_index`, the nullifier PDAs). Postgres is only an indexed view. After restore, reconcile:

```bash
# Force the relayer to rehydrate the deposit cache from chain.
ssh prod "docker compose restart octora-api"

# The boot log will print:
#   "mixer: hydrated deposit cache from chain"
# with depositsLoaded / scannedSignatures counts. Verify those match
# what you'd expect for the elapsed time since the snapshot.
```

For position state: any position that progressed on-chain after the snapshot but before the restore is now stale in the DB. The recovery worker will pick those up on its first tick — give it 5 min and re-check `/metrics.positions.byState`.

## 5. Resume writes

```bash
ssh prod "docker compose start octora-api"
```

Watch `/health` flip GREEN within 30s. If `db.ok` is `false`, the restore didn't take — back to §2.

## 6. User communication

Post the same shape as the pause runbook (`mixer-pause.md` §4):

- What happened (data integrity issue, paused for restore).
- Status now (restored, validated, resumed).
- Any user-visible state lag (e.g., positions created in the last hour may need to be re-submitted).
- Next steps for affected users.

## 7. After-action

- Run the **next** backup immediately. The restore proves the backup chain works; the next one captures the post-restore baseline.
- File a 7-day post-mortem with the same sections as `program-bug-response.md` §9.
- If the restore took > 30 min, treat that as a regression in the backup posture. The drill cadence (monthly) is your insurance against backups silently breaking.

## Drill protocol (monthly)

1. Provision a throwaway Postgres VM.
2. Pull the most recent snapshot from S3 to it.
3. Run §2a end-to-end.
4. Connect octora-api in `staging` mode against the restored DB and run the smoke test.
5. Tear down. Note the wall-clock time.

A monthly successful drill means a real restore takes 30 min. A skipped drill means a real restore takes 4 hours and your backup chain has been quietly broken since the last release.
