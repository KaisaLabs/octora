# Incident: pause / unpause the protocol (P1-45)

**Status:** Authoritative procedure for engaging the on-chain pause kill-switch on either or both programs.
**Last updated:** 2026-05-10.
**Severity:** P0 — practiced quarterly; the day you need to pause is not the day to read the runbook.

## When to pause

Pause is the **first** lever, before any program upgrade or treasury sweep. Engage when any of:

- A real or suspected exploit against `octora-mixer` or `octora-executor` (e.g. Sentry storms tagged `withdraw` or `addLiquidity`, on-chain balance anomalies, an unsolicited tip on Discord with proof).
- A regression in upstream Meteora DLMM / DAMM that's draining LP positions.
- A relayer key compromise during the window between detection and the rotation runbook completing (`runbooks/deployment/key-rotation.md`).
- A failed program upgrade attempt — pause before re-deploying.

When in doubt, pause. The cost of a false positive is "users see a friendly banner for an hour"; the cost of a missed real positive is fund loss.

## Pre-flight (~ 2 min)

- [ ] Confirm at least 2 of 3 (beta) Squads signers are online and reachable via Slack.
- [ ] Open a Slack incident channel `#inc-octora-YYYYMMDD-<slug>`. Page on-call.
- [ ] Snapshot the current state: `solana program show <PROGRAM_ID>` for both programs, `/health` and `/metrics` from the API. Paste into the channel.
- [ ] Decide which programs to pause:
  - Mixer-only (e.g. ZK trouble or relayer compromise).
  - Executor-only (e.g. Meteora DLMM regression).
  - Both (broad incident — default if unclear).

## 1. Build the pause transactions

Run from a Squads-signer's machine:

```bash
# Pause mixer (any denomination):
pnpm --filter octora-api exec tsx scripts/admin-set-paused.ts \
  --program mixer \
  --denomination 1000000000 \
  --paused true \
  --rpc <PROD_RPC>

# Pause executor:
pnpm --filter octora-api exec tsx scripts/admin-set-paused.ts \
  --program executor \
  --paused true \
  --rpc <PROD_RPC>
```

(If `scripts/admin-set-paused.ts` doesn't exist yet, write it as a one-shot Anchor caller — `program.methods.setPaused(true).accounts({...}).transaction()` then export base58 for Squads to sign.)

The CLI emits an unsigned base58 transaction. Paste into Squads as a new proposal.

## 2. Co-sign + execute

1. First Squads signer creates the proposal.
2. Second Squads signer approves.
3. Execute. Squads handles the SOL fee from the vault.

## 3. Verify

```bash
solana account <MIXER_POOL_PDA>     --output json
solana account <EXECUTOR_CONFIG_PDA> --output json
# `is_paused` / `paused` field must be 1.
```

API-side:

- `/metrics.mixer.isPaused` flips to `true` within the next probe (≤ 30s).
- `/health` flips `mixer.ok` to `false` (the health check fails closed when paused).
- Frontend's `BetaWarningBanner` will show the "RPC unreachable" or amber state once the API starts returning 503s — this is correct, the app should signal it's unsafe to act.

If verification fails (e.g. account still shows `is_paused = 0` after 30s), the Squads tx didn't land — re-check signature and resubmit.

## 4. User-facing communication

- Post on Twitter/X and the team's official channel: *"Octora is paused while we investigate <X>. Funds are safe; no action required. Will update in 30 min."*
- Post in Discord / Telegram with the same message.
- Update the frontend status page if one is live; otherwise put a one-line banner above `BetaWarningBanner` via a build-time env var (`VITE_INCIDENT_BANNER`).

Do NOT speculate on root cause publicly until at least one engineer has reproduced the issue.

## 5. Investigation

While paused:

- Run `getRecentBlockhash`, `getSignaturesForAddress` on the affected PDA, and `solana logs --commitment finalized <PROGRAM_ID>` to capture the suspect tx range.
- Pull Sentry traces tagged with the route and timeframe.
- Snapshot the API's Postgres position state for the affected wallets (`SELECT * FROM "Position" WHERE updatedAt > '<incident_start>'`).

Pause does not block reads — `getPosition`, `/health`, `/metrics`, and the indexer all keep working.

## 6. Resume

Only resume after:

- Root cause identified (or contained — e.g., a key was rotated and the old key swept).
- Fix landed on `main`, deployed to staging, smoke-tested.
- A Squads-signer briefing summarises what failed and what the fix changes.

To unpause:

```bash
pnpm --filter octora-api exec tsx scripts/admin-set-paused.ts \
  --program mixer    --paused false --rpc <PROD_RPC>
pnpm --filter octora-api exec tsx scripts/admin-set-paused.ts \
  --program executor --paused false --rpc <PROD_RPC>
```

Squads co-sign + execute as before. Verify both programs show `paused = false` and `/metrics.mixer.isPaused === false`.

Communicate the resume publicly with a brief postmortem timeline.

## 7. After-action

- File a public post-mortem within 7 days. Include: timeline, root cause, what failed in detection, what the fix was, what we changed to prevent recurrence.
- Add a regression test for the failure mode (`octora-api/src/modules/...__tests__` for API-side; `tests/octora-*.ts` for on-chain).
- Update this runbook if any step was unclear or wrong.

## Drill cadence

Every quarter:

1. Schedule a 30-min slot with the Squads signers + on-call.
2. Pause + unpause on **devnet**. Time how long each step took.
3. Note any UX friction — slow Squads UI, missing CLI flags, a runbook step that's stale.
4. Update the runbook in the same week.

A drilled team pauses in under 5 minutes from detection. A team that's never drilled pauses in 45 minutes, which is enough time for an exploit to drain everything you have.
