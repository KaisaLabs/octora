# Secrets management + log retention

**Why this matters:** secrets in env files on the production VM are one `cat` away from compromise if anyone has SSH access. A managed secrets store with sync to the VM (rather than long-lived files) reduces blast radius and gives you a rotation primitive. Log retention matters because the relayer logs IP + recipient combinations that, if kept, would defeat the privacy delay.

**Closes:** P1-43 (secrets management automation), P3-NEW-H (log rotation), P1-17a (relayer log retention).

## Tool choice

| Tool | Cost | Setup time | Notes |
| --- | --- | --- | --- |
| **Doppler** | Free 5 users, $7/user beyond | 30 min | Recommended — best DX for this case |
| 1Password Developer | $19/mo | 1 hour | Strong if your team already uses 1Password |
| AWS Secrets Manager | $0.40/secret/mo + API calls | 2 hours | Good if all-in on AWS — already used for relayer keys per `03_RELAYER_KMS.md` |
| HashiCorp Vault | Free OSS / paid cloud | 1 day | Overkill for MVP; revisit at public launch |

**Recommendation: Doppler for app secrets, AWS Secrets Manager for the relayer keypair (already established in `03_RELAYER_KMS.md`).** Doppler is fastest; AWS SM for the keypair gives you a single audit trail in CloudTrail for the highest-value secret.

## Secrets inventory

| Secret | Where it's used | Tool | Rotation cadence |
| --- | --- | --- | --- |
| `DATABASE_URL` | API | Doppler | 90 days |
| `RELAYER_RPC_URL` (and key) | API | Doppler | 90 days |
| `INDEXER_RPC_URL` (and key) | API | Doppler | 90 days |
| `SENTRY_DSN` (backend) | API | Doppler | yearly |
| `VITE_SENTRY_DSN` (frontend) | build env | Doppler | yearly |
| `BETA_ADMIN_TOKEN` (bearer for /admin/waitlist) | API | Doppler | 30 days |
| `FRONTEND_URL` | API CORS | Doppler | n/a |
| `KMS_KEY_ARN` (relayer mixer) | API | Doppler | n/a (key itself rotated separately) |
| `KMS_KEY_ARN` (relayer executor) | API | Doppler | n/a |
| `RELAYER_KEYPAIR` (encrypted blob) | API | AWS Secrets Manager | 90 days |
| Squads signer keys | offline (Ledger) | not in any digital secret store | n/a |
| Database snapshots S3 access key | backup cron | Doppler | 90 days |

The Squads signer keys are the only secrets that should never live in any digital store. Hardware wallets only.

## Doppler setup

### 1. Create projects

```
doppler projects create octora --description "Octora mainnet beta"
```

Environments: `dev`, `staging`, `production`.

### 2. Populate secrets

For production:

```
doppler secrets set --project octora --config production \
  DATABASE_URL="..." \
  RELAYER_RPC_URL="..." \
  SENTRY_DSN="..." \
  ...
```

Use the Doppler UI for sensitive ones — never paste relayer-related secrets into shell history.

### 3. Install Doppler CLI on the production VM

```
curl -Ls https://cli.doppler.com/install.sh | sh
doppler login    # browser-based auth, then save token
doppler setup --project octora --config production
```

### 4. Wire docker-compose

In `infra/docker-compose.prod.yml`, replace `env_file: ./octora-api.env` with:

```yaml
services:
  octora-api:
    # ... existing config ...
    env_file: []   # remove file
    environment:
      # Doppler injects all secrets via the run command
```

And run via:

```
doppler run -- docker compose -f infra/docker-compose.prod.yml up -d
```

`doppler run` exports all configured secrets as env vars to the docker compose subprocess. `compose` then passes them through to containers via `environment:` (which docker compose reads from the host env if no value is given).

Or simpler — write `doppler secrets download --no-file --format env > /etc/octora.env` on a cron, and have `env_file:` point to that file. Trade-off: file lives on disk for the gap between writes (seconds), versus Doppler-injected which has a longer-running process holding secrets in memory.

For MVP go with the cron-rewrite approach because docker compose `up -d` doesn't trivially restart on env change otherwise.

### 5. Sync cron

`/etc/cron.d/doppler-sync`:

```
*/5 * * * * root /usr/local/bin/doppler secrets download --project octora --config production --no-file --format env > /etc/octora.env && chmod 600 /etc/octora.env && chown root:docker /etc/octora.env
```

Then `infra/docker-compose.prod.yml`:

```yaml
services:
  octora-api:
    env_file: /etc/octora.env
```

`docker compose up -d` re-reads env on next deploy. For runtime hot-reload of secrets, you'd need a webhook from Doppler to trigger compose restart — not needed for MVP.

### 6. Doppler service tokens

For CI/CD (`.github/workflows/deploy.yml`):

- Create a Doppler service token scoped to `octora/production` with read-only access.
- Store the token in GitHub Actions secret `DOPPLER_TOKEN_PROD`.
- CI uses `doppler secrets download` with this token to materialize prod secrets at deploy time only.

## Rotation cadence

Calendar reminder every 30 days for `BETA_ADMIN_TOKEN`. Every 90 days for everything else.

Rotation procedure (use `BETA_ADMIN_TOKEN` as example):
1. Generate new token: `openssl rand -hex 32`.
2. Set in Doppler under a new key: `BETA_ADMIN_TOKEN_NEW`.
3. Deploy code that accepts both `BETA_ADMIN_TOKEN` and `BETA_ADMIN_TOKEN_NEW` for one cycle.
4. Update operator's password manager / scripts to use `BETA_ADMIN_TOKEN_NEW` value.
5. After 24 h, deploy code that drops the old name and renames new → canonical.
6. Delete old secret in Doppler.

For `DATABASE_URL` rotation: rotate Postgres password, update DSN in Doppler, restart API. Brief downtime acceptable during beta low-traffic window.

## Log retention

The relayer's HTTP access log includes the recipient pubkey and the IP of the proof submission. Keeping these defeats the privacy delay (an attacker with log access can correlate proofs to IPs even after the on-chain data is unlinkable).

Three layers:

### 1. Pino redaction (in code, already shipped)

`octora-api/src/common/observability.ts` redacts: `signature`, `signedMessage`, `Authorization`, `x-signed-nonce`, `x-signature`, `x-wallet-address`. Verify it also redacts:

- `req.body.recipient`
- `req.body.publicInputs[64..96]` (recipient bytes from withdraw payload)
- `req.body.proof` (large, no value in logs anyway)

If not, engineer A adds.

### 2. Docker JSON log driver size cap (P3-NEW-H)

`infra/docker-compose.prod.yml`:

```yaml
services:
  octora-api:
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: 3
```

Caps log file size at 30 MB total per container. Old logs auto-rotate.

### 3. Caddy access log retention

Caddy access logs include path and may include query strings (which during beta we should ensure don't carry recipient pubkeys). In `infra/Caddyfile`:

```
log {
  output file /var/log/caddy/access.log {
    roll_size 10mb
    roll_keep 3
    roll_keep_for 24h
  }
  format json
}
```

24 h retention. After that, logs are deleted.

For audit / debugging beyond 24 h: use Sentry (which redacts) or send a sanitized summary to a managed log aggregator.

### 4. Sentry retention

Sentry events keep stack traces and breadcrumbs for 90 days on the team plan. Confirm no PII (wallet addresses, pubkeys, signatures) reach Sentry. Run a "PII spot check" after Day 5: produce a few intentional errors, inspect Sentry events for any pubkey-shaped string.

## What NOT to do

- ❌ Commit any secret to the repo. `.gitignore` for `*.env` and `.env.*`. Configure `git-secrets` pre-commit hook.
- ❌ Print secrets in CI logs. GitHub Actions auto-redacts known secrets, but compose output may leak.
- ❌ Use `latest` tag for Doppler CLI in production cron. Pin a version.
- ❌ Store the relayer keypair in Doppler — use AWS Secrets Manager for it (per `03_RELAYER_KMS.md`).
- ❌ Have the operator share Doppler login. Use service tokens for systems, individual logins for humans.

## Reference

- Doppler docs: https://docs.doppler.com/docs
- Existing `infra/docker-compose.prod.yml` — engineer modifies env_file + logging.
- Existing `infra/Caddyfile` — log rotation block to add.
- Existing `runbooks/deployment/secrets.md` — current manual procedure (this file supersedes for MVP).
