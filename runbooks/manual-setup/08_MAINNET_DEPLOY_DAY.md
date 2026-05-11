# Mainnet deploy day runbook

**Day 14 of the launch plan.** This is the go-live runbook. Read it Day 13 and rehearse on devnet. Do not improvise on Day 14.

**Closes:** P0-1 (admin authority swap), P0-6 (Anchor.toml mainnet IDs), P1-7 (Squads upgrade authority transfer), P2-12 (IDL publish).

## Pre-flight checklist (Day 13)

All must be ✅ before starting Day 14:

| Item | Owner | Verified by |
| --- | --- | --- |
| Week 3 RC commit tagged | Engineer | `git tag --list week-3-rc` |
| All P0 / P1 in-code items closed | Engineer | `runbooks/PRODUCTION_READINESS.md` open-items dashboard empty |
| CI green on tagged commit | CI | GitHub Actions passing |
| `cargo audit` + `pnpm audit` clean | CI | green badge |
| Trusted setup ceremony complete | Operator + contributors | All transcripts in `runbooks/ceremony/transcripts/` |
| On-chain VK matches final ceremony zkey | Engineer A | Test suite passing with final VK |
| Squads multisig provisioned and tested on devnet | Operator + signers | No-op pause tx executed on devnet |
| KMS keys provisioned and funded for mainnet | Operator | AWS console + `solana balance` |
| Dedicated RPC endpoints provisioned | Operator | Health probes succeed against new URLs in staging |
| Lawyer-reviewed ToS / Privacy / Risk Disclosure live | Operator | URLs reachable, signed message format frozen |
| Beta tester agreements signed | Operator | PDFs in `runbooks/legal/cohort/` |
| Doppler production env populated | Operator | `doppler secrets list --config production` |
| Sentry, UptimeRobot, PagerDuty, status page live | Operator | Dashboards open |
| Final dress rehearsal on devnet completed | All | Tagged `week-3-devnet-rehearsal` |
| Tabletop incident drills run | All | Documented in `runbooks/incident/tabletop-2026-MM-DD.md` |
| Communications draft ready (status page incident, beta cohort email, internal #war-room channel) | Operator | Drafts in `runbooks/launch/communications/` |

## Roles on the day

- **Operator (you)** — drives the deploy script, communicates with signers, posts status updates.
- **Engineer A** — on-call for program / relayer issues. Standby on Discord/Slack, do NOT take other meetings.
- **Engineer B** — on-call for API / frontend issues. Same.
- **Squads signers** — on-call for the upgrade authority transfer signing (Step 8).
- **Beta testers** — NOT contacted yet. Day 15.

## Order of operations

### Step 1 — Build verifiable mainnet binaries

```
cd programs/
git checkout week-3-rc
docker run --rm -v $PWD:/workdir solana-verify-builder:1.79 \
  cargo build-sbf --release
sha256sum target/deploy/octora_mixer.so > mixer.sha256
sha256sum target/deploy/octora_executor.so > executor.sha256
```

Two engineers independently rebuild from the same tag and confirm matching hashes. If they don't match, halt — investigate before continuing.

### Step 2 — Generate fresh program-id keypairs offline

On an air-gapped or freshly-booted machine:

```
solana-keygen new --no-bip39-passphrase --outfile octora_mixer-keypair.json
solana-keygen new --no-bip39-passphrase --outfile octora_executor-keypair.json
```

Record the program IDs (`solana-keygen pubkey <file>`).

**Critical:** these keypairs are used ONCE to deploy the program, then placed in cold storage. They are not the upgrade authority — that's Squads. But they sign the initial deploy.

Back up to: encrypted USB, off-site safe, sealed envelope. Two copies, two locations. If lost, the program ID is permanently lost — but since upgrade authority is Squads, the program itself is unaffected. Loss only matters if you ever wanted to redeploy at the same address (impossible without these keypairs).

### Step 3 — Deploy `octora-mixer`

Use the deployer wallet (a freshly-generated wallet with ~5 SOL — burn after deploy):

```
solana program deploy target/deploy/octora_mixer.so \
  --program-id octora_mixer-keypair.json \
  --keypair deployer-keypair.json \
  --url <RELAYER_RPC_URL>
```

Record the deploy transaction signature. Confirm:

```
solana program show <MIXER_PROGRAM_ID>
# Authority should currently be: deployer pubkey
# Last deployed Slot: <recent>
```

### Step 4 — Deploy `octora-executor`

Same as Step 3 with the executor binary.

### Step 5 — Initialize executor `Config`

The executor needs its `Config` PDA initialized with the Squads vault as authority:

```
# Use the existing initialization script:
node scripts/init-executor-config.js \
  --program-id <EXECUTOR_PROGRAM_ID> \
  --authority <SQUADS_VAULT_PDA> \
  --rpc <RELAYER_RPC_URL>
```

Confirm `Config` account exists and `authority == SQUADS_VAULT_PDA` and `paused == false`.

### Step 6 — Initialize three mixer pools

Initialization currently uses the `permissionless-init` feature on devnet, but mainnet binaries are gated by `ADMIN_AUTHORITY` constant which is the Squads vault PDA per Step 7 of `01_SQUADS_MULTISIG.md`.

For each pool, the initialization tx must be signed by the Squads vault:

```
# For each denomination
node scripts/init-mixer-pool.js \
  --program-id <MIXER_PROGRAM_ID> \
  --denomination 100000000     # 0.1 SOL
  --rpc <RELAYER_RPC_URL>
```

This script builds an unsigned transaction (since the Squads vault signs via the multisig flow). Operator submits via Squads UI → signers sign → executes.

Repeat for `1_000_000_000` (1 SOL) and `10_000_000_000` (10 SOL).

Confirm all three `MixerPool` accounts exist:

```
solana account <MIXER_POOL_PDA_0_1_SOL>
solana account <MIXER_POOL_PDA_1_SOL>
solana account <MIXER_POOL_PDA_10_SOL>
```

Each should show `authority == SQUADS_VAULT_PDA`, `denomination` matching, `is_paused == false`, `next_leaf_index == 0`.

### Step 7 — Publish IDLs

```
anchor idl init <MIXER_PROGRAM_ID> --filepath target/idl/octora_mixer.json --provider.cluster mainnet
anchor idl init <EXECUTOR_PROGRAM_ID> --filepath target/idl/octora_executor.json --provider.cluster mainnet
```

Confirm via Solana Explorer that both programs show their IDL.

### Step 8 — Transfer upgrade authority to Squads

```
solana program set-upgrade-authority <MIXER_PROGRAM_ID> \
  --new-upgrade-authority <SQUADS_VAULT_PDA> \
  --keypair deployer-keypair.json \
  --url <RELAYER_RPC_URL>

solana program set-upgrade-authority <EXECUTOR_PROGRAM_ID> \
  --new-upgrade-authority <SQUADS_VAULT_PDA> \
  --keypair deployer-keypair.json \
  --url <RELAYER_RPC_URL>
```

Confirm:

```
solana program show <MIXER_PROGRAM_ID>
# Authority must now be the Squads vault PDA

solana program show <EXECUTOR_PROGRAM_ID>
# Same
```

**This is the single most important step.** From now on, no upgrade can land without ≥ 2 signers.

### Step 9 — Burn the deployer wallet

After Step 8 confirms, send the deployer wallet's remaining SOL to the operations treasury and delete the keypair file:

```
solana transfer <TREASURY_WALLET> ALL --keypair deployer-keypair.json
shred -u deployer-keypair.json
```

The deployer wallet is no longer needed. If anyone obtains the keypair later, they can do nothing — the program is owned by Squads, not them.

### Step 10 — Update `Anchor.toml` and frontend env

In the same commit:

```toml
[programs.mainnet]
octora_mixer    = "<MIXER_PROGRAM_ID>"
octora_executor = "<EXECUTOR_PROGRAM_ID>"
```

In Doppler `production`:

```
SOLANA_NETWORK=mainnet-beta
MIXER_PROGRAM_ID=<MIXER_PROGRAM_ID>
EXECUTOR_PROGRAM_ID=<EXECUTOR_PROGRAM_ID>
RELAYER_SIGNER_KIND=kms
```

In Doppler `production` for frontend (Vercel/Netlify env):

```
VITE_NETWORK=mainnet-beta
VITE_MIXER_PROGRAM_ID=<MIXER_PROGRAM_ID>
VITE_EXECUTOR_PROGRAM_ID=<EXECUTOR_PROGRAM_ID>
VITE_API_URL=https://api.octora.<domain>
VITE_SENTRY_DSN=<frontend-dsn>
```

Commit the `Anchor.toml` change with message `mainnet deploy 2026-MM-DD: <mixer-id> + <executor-id>` and the deploy signatures recorded in the commit body.

### Step 11 — Deploy the frontend and backend

Backend:
```
git push origin week-3-rc:production-deploy
# CI deploys via .github/workflows/deploy.yml
# Confirms /health green before completing
```

Frontend:
```
# Build with mainnet env, deploy to chosen host (Vercel/Netlify/Cloudflare Pages)
cd octora-web
npm run build  # uses VITE_NETWORK=mainnet-beta
vercel --prod  # or equivalent
```

### Step 12 — Smoke test (team wallets only)

With 2 team members on Discord/Slack, on a freshly-installed Phantom wallet:

1. Connect wallet on production frontend.
2. Sign ToS (server-side ack confirmed in Doppler-fronted Postgres).
3. Pre-fund team wallet with 0.5 SOL.
4. Deposit 0.1 SOL into the 0.1 SOL pool.
5. Confirm `DepositEvent` in Sentry breadcrumbs and on Solana Explorer.
6. Wait for privacy delay.
7. Generate proof in browser, post to relayer.
8. Confirm withdraw on Explorer; recipient is the stealth wallet.
9. Stealth wallet pays gas for `executor.dlmm_init_position` against a small DLMM pool.
10. Confirm position created on-chain.
11. Trigger private exit. Confirm full flow → SOL returns to main wallet via mixer.
12. Solana Explorer graph traversal: confirm no direct stealth → main transfer.

If any step fails, halt. Triage. Fix. Re-deploy if necessary. Do NOT proceed to Step 13 until smoke test is fully green.

### Step 13 — Document state and tag

```
git tag mainnet-deploy-2026-MM-DD
git push --tags
```

Update `runbooks/launch/deploy-log-2026-MM-DD.md` with:

- Deploy signatures for both programs
- Init signatures for executor `Config` and three mixer pools
- IDL publish signatures
- Upgrade authority transfer signatures
- Smoke test result
- All program IDs and PDAs

### Step 14 — Stop. Wait until tomorrow.

Day 14 is over. Day 15 = beta open. Sleep. The system is live but no users are on it yet.

## Day 15 — Beta open

### Approve beta wallets

For each tester whose signed agreement you have:

```
curl -X POST https://api.octora.<domain>/admin/waitlist/approve \
  -H "Authorization: Bearer $BETA_ADMIN_TOKEN" \
  -d '{ "walletAddress": "<TESTER_PUBKEY>", "note": "Cohort 1, signed YYYY-MM-DD" }'
```

Confirm in DB: `BetaAccess` row exists for each tester.

### Send onboarding emails

Template at `runbooks/launch/communications/beta-tester-welcome.md`. Includes:

- Frontend URL
- ToS link
- Status page link
- Support channel link (Discord / email)
- Brief "what to expect" — three pools, anonymity-set behavior, private-exit flow
- Bug-reporting channel (`security@octora.<domain>` for vulnerabilities)
- Per-position cap (2.5 SOL) and total cap (10 SOL)

### Open the channels

- Status page: status updated to "All systems operational."
- Support Discord: open invite for testers.
- War-room channel: keep operator + both engineers active first 4 hours.

### Watch

For the first 4 hours of beta:
- Sentry inbox refresh every 15 min
- Custom dashboard refresh every 15 min
- Status page no incidents
- Tester support channel monitored continuously

After 4 hours, switch to PagerDuty + daily check-ins per `06_MONITORING_ALERTING.md`.

## Rollback / emergency procedures

### Pause via Squads

If anything looks off — unusual relayer balance, unexpected error spike, tester reports stuck funds:

1. Operator pages all signers via PagerDuty L4.
2. Operator drafts `set_paused(true)` proposal in Squads UI for both `octora-mixer` (per pool) and `octora-executor`.
3. Signers review the proposal — confirm it's a legitimate pause, not a phishing redirect.
4. ≥2 signers approve. Operator (or any signer) executes.
5. Status page updated to "Maintenance — investigating."
6. Triage in war room.

Procedure detail: `runbooks/incident/mixer-pause.md`.

### Hot-fix deploy

If a non-critical bug is found in API or frontend (no fund risk):

1. Engineer fixes on a hotfix branch.
2. CI runs.
3. Deploy via standard `.github/workflows/deploy.yml` to staging.
4. Operator verifies fix on staging.
5. Deploy to production.
6. Status page incident closed.

If the bug is in a Solana program: PAUSE, then upgrade via Squads. Do NOT deploy a program upgrade without the Squads multisig flow.

### Tester refund

If a tester loses funds due to a system bug (not user error):

1. Triage. Document the failure mode in `runbooks/incident/`.
2. Operator transfers from operations treasury to tester's main wallet.
3. Email tester with the refund tx signature and an apology.
4. Add a regression test for the failure mode before resuming.

Operations treasury should hold ≥ 50 SOL during beta as a refund float. Document the threshold in `06_MONITORING_ALERTING.md` as a P3 alert.

## Post-launch checklist (Day 16+)

- Daily ops checklist per `06_MONITORING_ALERTING.md`.
- Weekly tester check-in: short survey on UX, friction points, perceived issues.
- Weekly metric review: TVL per pool, anonymity sets, withdrawal success rate, support channel volume.
- 30-day milestone: review whether to expand cohort, raise caps, list bug bounty.
- 90-day milestone: external audit results in (assuming Day-1 procurement). Plan public-launch readiness sprint based on audit findings.

## What NOT to do

- ❌ Skip the Day 13 dress rehearsal.
- ❌ Do Step 8 (upgrade authority transfer) before Step 6 (pool init). If you do it wrong, you can't initialize the pools without going through Squads, which adds friction.
- ❌ Use a recycled deployer wallet — fresh keypair only.
- ❌ Initialize pools with `permissionless-init` build on mainnet — that's the devnet feature only. The mainnet binary must be the gated build.
- ❌ Open beta to testers without all 12 smoke-test steps green.
- ❌ Deploy a frontend mainnet build without verifying it carries the right `VITE_NETWORK` and program IDs (it should THROW at module load if mismatched per P1-34).
- ❌ Forget to send the beta agreement BEFORE approving the wallet.

## Reference

- `01_SQUADS_MULTISIG.md` — Squads details
- `02_TRUSTED_SETUP_CEREMONY.md` — VK derivation
- `03_RELAYER_KMS.md` — KMS setup
- `runbooks/deployment/MAINNET.md` — original detailed step-by-step (this file is the operator-friendly index)
- `runbooks/incident/mixer-pause.md` — emergency pause procedure
- `runbooks/incident/program-bug-response.md` — what to do if a program bug surfaces
