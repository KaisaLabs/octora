# Octora — Mainnet bring-up checklist

**Status:** Authoritative deploy procedure for the private beta.
**Last updated:** 2026-05-10.
**Audience:** The two engineers executing the mainnet deploy. Read end-to-end before starting.

This is the single source of truth for taking Octora from devnet to mainnet. Every deploy artifact, env-var, and on-chain transaction lives here. Companion runbooks:

- `runbooks/deployment/upgrade-authority.md` — transferring BPF upgrade authority to Squads multisig (P1-7).
- `runbooks/deployment/key-rotation.md` — rotating the relayer's hot wallet (P1-45).
- `runbooks/PRODUCTION_READINESS.md` — full audit + severity legend.

## 0. Pre-flight (do not start the deploy until every box is checked)

- [ ] `chore/mainnet-readiness` (or its successor) merged to `main`. The mainnet build MUST come from a tagged commit.
- [ ] All Day 1–3 items in `runbooks/PRODUCTION_READINESS.md` §9 closed.
- [ ] Trusted-setup ceremony complete (P0-2). Final `withdraw.zkey` checked into the repo, `verification_key.json` regenerated, ceremony transcript in `runbooks/ceremony/` (per-round attestations + hashes).
- [ ] Circuit recipient/relayer binding (P0-3) landed and the verifying-key bytes in `programs/octora-mixer/src/verifier/groth16.rs` regenerated from the post-ceremony `.zkey`.
- [ ] Cargo workspace has `[profile.release] overflow-checks = true` (P1-8).
- [ ] `anchor test` clean against fresh fixture accounts (P1-48).
- [ ] End-to-end devnet smoke test (deposit → withdraw via the relayer) green within the last 24h.
- [ ] Mainnet RPC procured (Helius / Triton / QuickNode) — separate endpoints for relayer (write), indexer (read-heavy), and the public web (CDN-cached). Endpoints recorded in the ops password vault.
- [ ] Squads vault created and 2-of-3 (beta) signers identified. Signers sit on independent hardware, recovery contacts are known. Vault PDA recorded.
- [ ] Mainnet relayer hot wallet generated on a hardened machine (NOT the API host). Initial balance ≤ $500. KMS / signing-service plan documented (P0-21).
- [ ] Operator bearer token (`OCTORA_ADMIN_API_TOKEN`) generated (≥ 32 bytes, base64). Stored in the secrets manager only.
- [ ] Beta-cohort ToS finalized (P1-51). Per-wallet ack flow tested on staging.

## 1. Build

Build with `--features` defaulting (so the `permissionless-init` gate stays OFF) and the Solana mainnet target:

```bash
# Workspace root
anchor build --no-idl
# Sanity: every program built in `target/deploy/*.so` came from this commit
sha256sum target/deploy/octora_executor.so target/deploy/octora_mixer.so
git log -1 --format=oneline
```

Pin the program SHAs in the deploy ticket. They are the artifacts you'll later prove match the on-chain bytecode.

## 2. Generate fresh program keypairs

A fresh, never-used keypair is **mandatory**. Reusing devnet IDs invalidates the audit assumptions and the placeholder `ADMIN_AUTHORITY` seal logic in `constants.rs`.

```bash
mkdir -p target/deploy/keys.mainnet
solana-keygen new --no-bip39-passphrase -o target/deploy/keys.mainnet/octora_executor.json
solana-keygen new --no-bip39-passphrase -o target/deploy/keys.mainnet/octora_mixer.json

# Capture the pubkeys — these are the program IDs.
solana address -k target/deploy/keys.mainnet/octora_executor.json
solana address -k target/deploy/keys.mainnet/octora_mixer.json
```

Both keypair files go into the **sealed offline store** (1Password Vault → "Octora / Mainnet / Program Keys"). They are NEVER committed to git.

## 3. Patch source with the new program IDs

In one commit on a deploy branch (`deploy/mainnet-YYYY-MM-DD`):

| File | Change |
| --- | --- |
| `Anchor.toml` | Uncomment `[programs.mainnet]`, fill both IDs |
| `programs/octora-executor/src/lib.rs` | Update `declare_id!("...")` |
| `programs/octora-mixer/src/lib.rs` | Update `declare_id!("...")` |
| `programs/octora-mixer/src/constants.rs` | Replace the `ADMIN_AUTHORITY` placeholder bytes with the Squads vault PDA |
| `programs/octora-executor/src/constants.rs` | Replace the `EXECUTOR_ADMIN_AUTHORITY` placeholder bytes with the same Squads vault PDA |

Re-run `anchor build` after the source patches. Re-record the SHAs.

## 4. Deploy

Use the workspace `solana` config pointed at the production RPC, NOT public mainnet-beta:

```bash
solana config set --url <HELIUS_OR_TRITON_RPC>
solana config set --keypair <DEPLOY_PAYER_KEYPAIR>   # NOT the upgrade authority
solana balance                                       # ensure ≥ 5 SOL for both deploys

anchor deploy \
  --provider.cluster mainnet \
  --program-name octora_executor \
  --program-keypair target/deploy/keys.mainnet/octora_executor.json

anchor deploy \
  --provider.cluster mainnet \
  --program-name octora_mixer \
  --program-keypair target/deploy/keys.mainnet/octora_mixer.json
```

Verify each deploy:

```bash
solana program show <PROGRAM_ID>
# Programdata Address, Authority, Last deployed slot, Data length must match expectations.
```

## 5. Initialize the executor `Config` PDA

The executor refuses every state-mutating instruction until `Config.paused` exists and is `false`. `init_config` is gated on `EXECUTOR_ADMIN_AUTHORITY` (Squads vault PDA, set in step 3), so the call must be signed by the Squads multisig.

```bash
# Build an unsigned init_config tx, sign+send via Squads. Example helper:
pnpm --filter octora-api exec tsx scripts/init-executor-config.ts \
  --program-id <EXECUTOR_PROGRAM_ID> \
  --rpc <PROD_RPC>
```

(If `scripts/init-executor-config.ts` doesn't exist yet, write it as a one-shot — Anchor `program.methods.initConfig().rpc()` against the multisig signer.)

Verify:

```bash
solana account <CONFIG_PDA> --output json
# config.authority must equal the Squads vault PDA
# config.paused must be false
```

## 6. Initialize the mixer pool

`octora-mixer`'s `initialize` is similarly gated on `ADMIN_AUTHORITY`. Call it with the Squads multisig signing for the supported denomination:

```bash
pnpm --filter octora-api exec tsx scripts/init-mixer-pool.ts \
  --program-id <MIXER_PROGRAM_ID> \
  --denomination 1000000000 \
  --rpc <PROD_RPC>
```

Capture the pool PDA. The on-chain pool authority is now the Squads vault.

## 7. Publish on-chain IDLs (P2-12)

```bash
anchor idl init <EXECUTOR_PROGRAM_ID> \
  --filepath target/idl/octora_executor.json \
  --provider.cluster mainnet
anchor idl init <MIXER_PROGRAM_ID> \
  --filepath target/idl/octora_mixer.json \
  --provider.cluster mainnet
```

Both upload txs must be signed by the Squads vault.

## 8. Transfer BPF upgrade authority to Squads

Follow `runbooks/deployment/upgrade-authority.md`. Do **not** skip this — the audit (P1-7) treats single-key upgrade authority as a P1 blocker for the beta.

Smoke-check after transfer:

```bash
solana program show <EXECUTOR_PROGRAM_ID> | grep Authority
solana program show <MIXER_PROGRAM_ID>   | grep Authority
# Both must show the Squads vault PDA.
```

## 9. Stand up the API

The Day 2/3 work hardens this path. Before flipping DNS:

- [ ] `prisma migrate deploy` against the production Postgres. Confirm the four mainnet-readiness migrations applied.
- [ ] Secrets in the production secrets manager (Doppler / 1Password Secrets / Fly secrets):
  - `DATABASE_URL`
  - `FRONTEND_URL` (strict comma-separated allowlist — no `*` wildcard)
  - `OCTORA_EXECUTOR_PROGRAM_ID`, `OCTORA_MIXER_PROGRAM_ID` (from step 2)
  - `OCTORA_USE_ONCHAIN_EXECUTOR=true`
  - `OCTORA_EXECUTOR_RPC_URL`
  - `OCTORA_EXECUTOR_RELAYER_KEYPAIR` (KMS-backed; never a filesystem path on a shared host)
  - `OCTORA_MIXER_RELAYER_ENABLED=true` + the rest of the `OCTORA_MIXER_RELAYER_*` block
  - `OCTORA_ADMIN_API_TOKEN`
  - `BETA_MAX_POSITION_SOL`, `BETA_MAX_GLOBAL_TVL_SOL`, `BETA_MAX_POSITIONS_PER_WALLET`
  - `SENTRY_DSN` (after `pnpm add @sentry/node`)
  - `NODE_ENV=production`
- [ ] `/health` returns 200 with `{ db: ok, rpc: ok, relayer: ok, mixer: ok }`.
- [ ] `/metrics` returns mixer.balanceLamports matching the on-chain pool balance.
- [ ] Pre-approve the beta cohort:
  ```bash
  curl -H "Authorization: Bearer $OCTORA_ADMIN_API_TOKEN" \
       -H 'Content-Type: application/json' \
       -d '{"walletAddress":"<BETA_USER_PUBKEY>","note":"cohort-1"}' \
       https://api.octora.example/admin/waitlist/approve
  ```

## 10. Stand up the frontend

- [ ] `VITE_NETWORK=mainnet` and the matching `VITE_*_PROGRAM_ID` vars baked into the build (no client-side env var leaks).
- [ ] Network-mismatch banner verified in staging (P1-35).
- [ ] BETA / UNAUDITED warning + signed-ack ToS modal verified (P1-36, P1-51).

## 11. End-to-end smoke test on mainnet

Use a single dedicated mainnet wallet pre-loaded with a small amount of SOL. Run through:

1. `POST /auth/nonce` → sign → `POST /positions/intents` (expect 201, position state `draft`).
2. Sign + execute an `add-liquidity` against a low-tier DLMM pool.
3. `claim` and `withdraw-close`.
4. Independently: deposit → wait > privacy delay → withdraw via the relayer.
5. Verify the relayer-paid signature shows up in `/metrics` and Sentry never fired.

Pause the executor (`set_paused = true` via Squads), confirm `/positions/:id/execute` now 4xx's. Resume, confirm flow restored. The pause smoke test is the most important one — if it doesn't work the day you ship, you have no kill switch the day you need it.

## 12. Tag the deploy

```bash
git tag -s mainnet-deploy-YYYY-MM-DD -m "Octora mainnet beta deploy"
git push --tags
```

The tag commit must contain the patched `Anchor.toml`, `declare_id!`, and `ADMIN_AUTHORITY` constants from step 3 — nothing else. Cherry-pick onto the deploy branch if intermediate work has landed since.

## 13. After-action

- File a runbook entry capturing: deploy slot, program SHAs, IDs, Squads vault PDA, RPC endpoints used, ops dashboard URLs.
- Schedule the first weekly key-rotation drill (`key-rotation.md`).
- Confirm the bug bounty submission inbox / PagerDuty escalations are live (P2-53, P1-44).

## Rollback / kill-switch

The two emergency levers, in order of preference:

1. **Pause** — `set_paused = true` on either program via Squads. Mutating instructions fail closed; existing balances stay safe.
2. **Pause + redirect frontend** — the persistent banner explains the situation; users keep `getPosition` / `/health` / `/metrics` working.
3. **Program upgrade** — only with at least 2 of the 3 (or 3 of 5 once we hit public) Squads signers. Always pause first; never deploy a hot patch over a live un-paused program.

A program upgrade rollback is irreversible from the user's perspective if the new bytecode handles state differently than the old — practice the rollback path on devnet *before* you need it on mainnet.
