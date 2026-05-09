# Secrets management (P1-43)

**Status:** Authoritative procedure for managing every secret octora-api consumes in production.
**Last updated:** 2026-05-10.
**Cadence:** rotate every 30 days during private beta; quarterly after.

## Why this matters

The audit (`runbooks/PRODUCTION_READINESS.md` P1-43) is explicit: **no `.env` files on production hosts.** A `.env` checked into a build context, copied into a container, or sitting in `/srv/octora/` is a single shell-access compromise away from a relayer hot wallet drain or a database wipe. Every secret here must:

1. Live in a managed secrets store (Doppler / 1Password Secrets / AWS Secrets Manager / Fly.io secrets).
2. Be projected into the API process via the host orchestrator at boot, **never** baked into the image.
3. Have a documented rotation procedure and owner.

## Choose a secrets backend

For a private-beta single-VM deploy any of these is fine. Pick one and stick with it:

| Backend | Pros | Cons | When |
| --- | --- | --- | --- |
| **Fly.io secrets** | Zero ops, free, fly-CLI driven, restarts machines on update. | Tied to Fly. | Single-region beta on Fly. |
| **Doppler** | Multi-cloud, role-scoped projects, CLI + GitHub Action integrations, audit log. | Paid past free tier. | You already use Doppler elsewhere or want one tool across staging + prod. |
| **AWS Secrets Manager** | KMS-backed, IAM-scoped, rotates via Lambda. | AWS account + IAM setup. | Already on AWS; want KMS storage. |
| **1Password Secrets Automation** | Existing 1Password vaults, hardware-key gating, simple operator UX. | Requires a Connect server. | Team already on 1Password and wants ops-led rotation. |

Recommendation for the beta: **Fly secrets** if the deploy lives on Fly, **Doppler** otherwise.

## Required environment variables

Every variable below MUST be set in the secrets backend before the first prod boot. Items marked **rotate** have a documented procedure; the rest are static or build-time.

### Database & app shell

| Var | Purpose | Rotate? |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection string. Use a dedicated user with no superuser bit. | yes (per quarter) |
| `NODE_ENV` | Must be `production`. | no |
| `PORT` | Default 8787. | no |
| `FRONTEND_URL` | **Strict** comma-separated CORS allowlist. Wildcard rejected by the loader. | no |
| `LOG_LEVEL` | Pino level. `info` in prod. | no |

### Solana wiring

| Var | Purpose | Rotate? |
| --- | --- | --- |
| `OCTORA_USE_ONCHAIN_EXECUTOR` | `true` in prod. | no |
| `OCTORA_EXECUTOR_RPC_URL` | Premium mainnet RPC (Helius / Triton / QuickNode). | no |
| `OCTORA_EXECUTOR_PROGRAM_ID` | From `runbooks/deployment/MAINNET.md` step 2. | no (deploy-time) |
| `OCTORA_MIXER_PROGRAM_ID` | Same. | no |
| `OCTORA_EXECUTOR_RELAYER_KEYPAIR` | KMS reference or sealed file path. **Never inline.** | yes (30d) |
| `MIXER_DENOMINATION` | Lamports. Constant for the pool. | no |

### Mixer relayer (when `OCTORA_MIXER_RELAYER_ENABLED=true`)

| Var | Purpose | Rotate? |
| --- | --- | --- |
| `OCTORA_MIXER_RELAYER_ENABLED` | `true` to mount the relayer routes. | no |
| `OCTORA_MIXER_RELAYER_RPC_URL` | Same provider as the executor or a dedicated write-heavy endpoint. | no |
| `OCTORA_MIXER_RELAYER_HOT_WALLET` | KMS reference or sealed file path for the relayer keypair. | yes (30d) |
| `OCTORA_MIXER_RELAYER_MIN_FEE` | Floor priority fee in lamports. | yes (review monthly) |
| `OCTORA_MIXER_POOL_DENOMINATION` | Lamports. | no |
| `OCTORA_MIXER_PRIVACY_DELAY_MS` | Default 13000. | no |

### Beta + admin gates

| Var | Purpose | Rotate? |
| --- | --- | --- |
| `OCTORA_ADMIN_API_TOKEN` | Bearer for `/admin/*`. ≥ 32 bytes, base64. | yes (30d) |
| `BETA_MAX_POSITION_SOL` | Per-position cap. | no (config) |
| `BETA_MAX_GLOBAL_TVL_SOL` | Global cap. | no (config) |
| `BETA_MAX_POSITIONS_PER_WALLET` | Per-wallet cap. | no (config) |

### Observability

| Var | Purpose | Rotate? |
| --- | --- | --- |
| `SENTRY_DSN` | Required to enable error capture (P1-30). | yes (project rotation) |

## How secrets reach the API

```text
secrets-manager  ──projection──▶  host env  ──env_file──▶  octora-api container
```

The two acceptable projection mechanisms:

1. **Host orchestrator injects** the env at process start (Fly secrets, ECS task definitions). The container sees `process.env.DATABASE_URL` directly.
2. **Compose `env_file`** referencing a host-side file written by a secrets CLI right before `docker compose up`:

```bash
# Doppler example — runs on the deploy host, NOT in CI.
doppler secrets download --no-file --format=docker > /run/octora/octora-api.env
chmod 600 /run/octora/octora-api.env
docker compose --env-file /run/octora/octora-api.env up -d
```

The file is written to `/run/octora` (tmpfs) so it disappears on reboot. Never write to a persistent path.

## Forbidden patterns

These have all caused production incidents elsewhere; they are not allowed here:

- ❌ Committing `.env`, `.env.production`, `.env.local` — `.gitignore` already blocks `.env`.
- ❌ `COPY .env /app/.env` in any Dockerfile.
- ❌ Pasting a secret into a Slack channel, an issue comment, or a PR description.
- ❌ Reading secrets from the host filesystem and logging them at startup. Pino's `redact` rules (P1-30) cover the documented sensitive fields, but a `app.log.info(process.env)` call would still leak.
- ❌ Sharing the same admin token across staging and production. Each environment gets its own.

## Rotation procedure

### Quarterly admin token

1. `openssl rand -base64 32` → new token.
2. Update `OCTORA_ADMIN_API_TOKEN` in the secrets backend.
3. Trigger a rolling restart so the API picks up the new value.
4. Verify the old token returns 401 on `/admin/waitlist/approve`.
5. Document in the deploy ticket.

### 30-day relayer keypairs

See `runbooks/deployment/key-rotation.md` for the full step-by-step. The TL;DR: pre-fund a new key, swap the secret, rolling-restart, sweep the old key, sealed-offline disposal.

### Database password

1. Connect via `psql` as a superuser, `ALTER USER octora WITH PASSWORD '<new>'`.
2. Update `DATABASE_URL` in the secrets backend.
3. Rolling restart.
4. Confirm `/health` is GREEN with `db: ok`.

### Sentry DSN

If a Sentry project key leaks (e.g., shows up in a GitHub Actions log), rotate via the Sentry UI under *Project Settings → Client Keys*. Update `SENTRY_DSN`. The old key takes ~15 min to fully expire.

## Audit trail

For each rotation, record in the deploy ticket:

- What rotated (which env var).
- Old & new pubkeys / hashes (truncated; never the full secret).
- Who did it.
- The timestamp of the rolling restart.
- Health-check verification.

A 30-day rotation cadence with no audit trail is the same as no rotation.
