# Monitoring + alerting

**Why this matters:** during beta you cannot watch the system 24/7 by hand. Alerts must page you when something is wrong, and dashboards must tell the on-call engineer what's wrong fast.

**Closes:** P1-44 (monitoring + alerting baseline), part of P1-30 (Sentry), part of P0-21 (balance alarms — see also `03_RELAYER_KMS.md`).

## Stack

| Layer | Tool | Purpose | Cost/mo |
| --- | --- | --- | --- |
| Backend errors + traces | Sentry | API error capture, performance | $26 (team) |
| Frontend errors + sessions | Sentry | Browser error capture, session replay | included above |
| Uptime check | Better Uptime (or UptimeRobot) | `/health` ping every 60 s | $0–$30 |
| Paging | PagerDuty | On-call rotation, escalation | $21/user |
| Status page | Better Uptime built-in (or statuspage.io) | Public status for beta testers | included or $29 |
| Custom metrics | Self-hosted Grafana + Prometheus push, OR Sentry custom dashboards | Mixer TVL, anonymity sets, relayer balance | included if Sentry |
| Cloud alarms | CloudWatch (already needed for KMS balance) | KMS balance, CPU, disk | $5–$20 |

**Recommendation for MVP:** Sentry + Better Uptime + PagerDuty. Skip Grafana/Prometheus — use Sentry dashboards for custom metrics. Total < $100/mo.

## Sentry setup

### Backend (already wired — see P1-30)

`octora-api/src/common/observability.ts` already initializes Sentry with `SENTRY_DSN` and Pino redaction. Confirm:

- DSN set in Doppler production env.
- Redact list covers: `signature`, `signedMessage`, `Authorization`, `x-signed-nonce`, `x-signature`, `x-wallet-address`.
- Tags: `release: <git-sha>`, `environment: production`, `service: octora-api`.

### Frontend (Day 2 work)

In `octora-web/src/main.tsx`:

```ts
import * as Sentry from '@sentry/react';

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_GIT_SHA,
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
  ],
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,
  beforeSend(event) {
    // Hash wallet address before send
    if (event.user?.id?.length === 44) {
      event.user.id = sha256(event.user.id).slice(0, 16);
    }
    return event;
  },
});
```

PII protection:
- `maskAllText` so any visible text (including pubkeys) is masked in session replay.
- `wallet.signMessage` calls and signatures must never be logged. Add unit test that asserts no breadcrumb contains `signMessage`.
- Stealth wallet pubkeys must not be logged.

### Dashboards (Sentry → Performance → Custom Dashboards)

Create one dashboard per system area:

**Dashboard: API health**
- Error rate (5xx) by route
- p95/p99 latency for `POST /positions/intents`, `POST /positions/:id/execute`, `GET /mixer/pools`, `POST /relayer/withdraw`
- Active position count by state

**Dashboard: Mixer state**
- Custom metric `mixer.deposit.count` per denomination
- Custom metric `mixer.anonymitySet` per denomination (gauge)
- Custom metric `mixer.tvl_sol` per denomination (gauge)
- Custom metric `relayer.balance_sol` per wallet

**Dashboard: Frontend**
- JS error rate by page
- Wallet connect success rate
- Time to first proof-generated (browser ZK perf)

Custom metrics emitted from API:

```ts
// In recovery worker or a 60s cron
Sentry.metrics.gauge('mixer.anonymitySet', anonymitySet, {
  tags: { denomination: '1SOL' },
});
Sentry.metrics.gauge('relayer.balance_sol', lamports / 1e9, {
  tags: { wallet: 'mixer-relayer' },
});
```

## Better Uptime / UptimeRobot

Check: `GET https://api.octora.<domain>/health`
- Every 60 seconds
- Alert on 2 consecutive failures
- Send to: PagerDuty (P1)

Check: `GET https://octora.<domain>/`
- Every 60 seconds
- Alert on 3 consecutive failures
- Send to: PagerDuty (P3 — frontend hosted on CDN, cosmetic)

Check: `GET https://api.octora.<domain>/metrics`
- Every 5 minutes
- Used to confirm metrics endpoint is live and the snapshot includes expected fields
- Alert on 2 consecutive failures or stale snapshot (>5 min old)

## PagerDuty setup

One service: `octora-mainnet`.

Escalation policy:
- Level 1: operator (you), 5 min response window.
- Level 2: engineer A on-call, 10 min.
- Level 3: engineer B on-call, 15 min.
- Level 4: all signers (if pause is needed), 30 min.

Integrations:
- Sentry → PagerDuty for issues marked "regression" or "high" severity (configure Sentry alert rules).
- Better Uptime → PagerDuty for downtime.
- AWS CloudWatch → SNS → PagerDuty for KMS balance alarms (`03_RELAYER_KMS.md`).

Alert routing rules (PagerDuty event rules):

| Source | Match | Priority | Note |
| --- | --- | --- | --- |
| Sentry | `level:fatal` OR `tag.service:octora-api AND message:"position stuck"` | P1 | |
| Better Uptime | `/health down` | P1 | |
| CloudWatch | `relayer.balance < 0.5 SOL` | P3 | |
| CloudWatch | `relayer.balance dropped > 50% in 10 min` | P1 | Likely incident |
| CloudWatch | `relayer.balance dropped > 90% in 1 hour` | P0 | Likely compromise — wake everyone |

## Status page

Better Uptime has a free public status page. Components:

- Frontend (octora.<domain>)
- API (api.octora.<domain>)
- Relayer (synthetic check — submits a no-op to /health)
- Mixer pool 0.1 SOL
- Mixer pool 1 SOL
- Mixer pool 10 SOL

Auto-update from the existing checks. Manual incidents posted by operator during war room.

URL shared with beta testers in their onboarding email.

## Alert thresholds

Tune these after Week 1 of beta to reduce noise:

| Alert | Initial threshold | Action |
| --- | --- | --- |
| API 5xx rate | > 1% over 5 min | P2 — investigate |
| API p99 latency on `POST /relayer/withdraw` | > 5 s | P2 — investigate RPC |
| Mixer pool paused | any change to `is_paused` | P1 — operator already knows; this is audit log |
| New position stuck > 10 min | recovery worker capture | P2 — engineer reviews logs |
| `confirmed`-state position got reverted (P3-NEW-C tagged event) | any | P1 — manual reconciliation |
| KMS balance critical | see `03_RELAYER_KMS.md` | P0/P1/P3 |
| Anonymity set < 20 on a pool with attempted withdraws | any | P3 — UX issue, consider pausing that pool |
| Sentry releases > 5 errors per hour from frontend | unique users affected > 3 | P3 — investigate |

## Daily ops checklist (during beta)

Operator does this every morning:

1. Sentry inbox — anything new triaged?
2. Better Uptime — any unresolved incidents?
3. PagerDuty — any unclosed incidents from the night?
4. Custom dashboard — anonymity set > 20 on each pool? Relayer balances OK?
5. Status page — does it reflect reality?
6. Beta tester support channel — any unanswered messages?

Should take < 15 minutes.

## Tabletop (Day 13)

Walk through:
- A simulated `relayer.balance dropped > 90%` alert. Operator pages signers, signers sign pause. Time it.
- A simulated `position stuck > 10 min` Sentry capture. Engineer pulls position by ID, walks recovery, manually advances.
- A simulated `mixer pool paused` event. Operator drafts user-facing status page update.

Document timing actuals in `runbooks/incident/tabletop-2026-MM-DD.md`. If anything took > 5x the alert response window, fix the gap.

## What NOT to alert on

- Rate-limit rejections (expected behavior).
- ToS-ack-required 412s (expected on first session per version).
- Anonymity-set warning surfaced to user (expected during anonymity-set growth).
- Single transient RPC failure (already handled by retry).

Over-alerting is the path to ignoring alerts. Tune ruthlessly.

## Reference

- Sentry docs: https://docs.sentry.io/
- Better Uptime: https://betteruptime.com/
- PagerDuty docs: https://www.pagerduty.com/docs/
- Existing `octora-api/src/common/observability.ts` — backend Sentry init.
- Existing `octora-api/src/common/health.ts` — `/health` shape.
- Existing `octora-api/src/common/metrics.ts` — `/metrics` snapshot.
- Existing `runbooks/incident/` — runbooks PD links should reference.
