# Octora — Production Readiness & Mainnet Launch Requirements

**Status:** Pre-launch audit · Target: private mainnet beta (no public announcement)
**Last updated:** 2026-05-10 (revision 3 — added P0-NEW-I private-exit symmetry)
**Scope:** Everything that must be done before real users put real money into Octora on Solana mainnet.

This document is the single source of truth for mainnet-grade readiness. Findings come from a deep re-audit of:

- `programs/octora-mixer/` — Groth16 ZK mixer (Anchor)
- `programs/octora-executor/` — Meteora DLMM CPI wrapper (Anchor)
- `octora-api/` — Fastify backend, relayer, indexer, mixer service
- `octora-web/` — React/Vite frontend
- ZK circuits at `octora-api/src/modules/vault/circuits/`
- Deployment artifacts at `runbooks/`, `Anchor.toml`, `infra/`, `.github/workflows/`

Each item lists: **Severity · File(s) · Status · Required fix · Estimated effort**.
Effort is rough engineer-hours assuming familiarity with the codebase.

---

## 0. Severity legend

| Tag | Meaning |
| --- | --- |
| **P0 — BLOCKER** | Must be fixed before any mainnet deposit by anyone. Risk: fund loss, full system compromise, or regulatory exposure. |
| **P1 — REQUIRED FOR BETA** | Must be fixed before real users (even invited cohort) deposit. Risk: data loss, abuse, partial fund loss, broken UX in failure modes. |
| **P2 — REQUIRED BEFORE PUBLIC** | Can launch private beta without these, but must be done before opening signups or announcing publicly. |
| **P3 — POST-LAUNCH** | Hardening / nice-to-have. Track in backlog. |

## 0.1 Status legend

| Status | Meaning |
| --- | --- |
| **✅ FIXED** | Verified in code as of 2026-05-10 audit. |
| **⚠ PARTIAL** | Implemented but with caveats (e.g. file-based keypair instead of KMS). |
| **❌ OPEN** | Not done. Remaining mainnet-blocking work. |
| **📝 OPS** | Not a code change — operational task that must be done at deploy time (key generation, multisig setup, contract signing). |

---

## 1. Smart contract security (P0–P1)

### P0-1 · Permissionless mixer pool initialization — ✅ FIXED
- **File:** `programs/octora-mixer/src/instructions/initialize.rs:19–21`, `programs/octora-mixer/src/constants.rs:132–138`
- **Verified:** Initializer is pinned via `#[cfg_attr(not(feature = "permissionless-init"), account(mut, address = ADMIN_AUTHORITY @ MixerError::Unauthorized))]`. Devnet builds opt in via `--features permissionless-init`. `ADMIN_AUTHORITY` is currently a placeholder constant.
- **Remaining (📝 OPS):** Replace `ADMIN_AUTHORITY` placeholder with the real Squads multisig vault PDA before mainnet build. Confirm placeholder text is `OCTORA_MIXER_ADMIN_PLACEHOLDER`-style and would refuse to deploy.

### P0-2 · Trusted setup ceremony for Groth16 — ⚠ PARTIAL (📝 OPS pending)
- **Files:** `programs/octora-mixer/src/verifier/groth16.rs:163–170`, `octora-api/src/modules/vault/circuits/`, `runbooks/ceremony/PROCEDURE.md`
- **Verified:** Verifying key bytes are hardcoded (immutable post-deploy). `runbooks/ceremony/PROCEDURE.md` documents the multi-party Phase 2 procedure (≥3 contributors, attestations, transcript hashes, final-key derivation).
- **Remaining (📝 OPS):** Actually run the ceremony with ≥3 independent contributors before mainnet binary is built. Publish each contribution's `r1cs`/`zkey` hash + entropy attestation to `runbooks/ceremony/`. Re-derive the on-chain VK from the final `.zkey` and rebuild the program. **No mainnet deploy until this is done end-to-end.**

### P0-3 · Recipient/relayer binding in circuit — ✅ FIXED
- **File:** `octora-api/src/modules/vault/circuits/withdraw.circom:110–116`
- **Verified:** `paramsBinding = Poseidon(3)` over `(recipient, relayer, fee)`; the squaring-only pattern is gone. Recipient/relayer/fee remain as public inputs (line 120) so on-chain `withdraw.rs` can re-check, *and* the proof is now structurally bound.
- **Note:** Re-running P0-2 ceremony must occur *after* this circuit is final.

### P0-4 · Signer constraints on executor instructions — ✅ FIXED
- **Files:** `programs/octora-executor/src/instructions/dlmm/*.rs`
- **Verified:** All DLMM instructions declare `pub stealth: Signer<'info>`. Negative tests in `tests/octora-executor-dlmm-negative*.ts` exercise stealth-mismatch.

### P0-5 · Executor pause mechanism — ✅ FIXED
- **Files:** `programs/octora-executor/src/state/config.rs:18`, all `instructions/dlmm/*.rs`
- **Verified:** `Config` PDA has `paused: bool` + `authority: Pubkey`. Every mutating instruction has `constraint = !config.paused @ ExecutorError::Paused`. `set_paused` instruction is authority-gated.

### P0-6 · Anchor.toml mainnet pinning — ⚠ PARTIAL
- **File:** `Anchor.toml:15–30`
- **Verified:** `[programs.mainnet]` block is intentionally commented out with a guard comment explaining that uncommenting with placeholders breaks IDL/anchor-client semantics.
- **Remaining (📝 OPS):** After mainnet deploy with fresh keypairs, uncomment and fill real program IDs in the same commit that records the deploy signature. Commit the program-id keypairs to a sealed offline store (NOT the repo).

### P1-7 · Upgrade authority should be a multisig from day 1 — ❌ OPEN (📝 OPS)
- **Tooling:** Squads v3.
- **Verified:** `runbooks/deployment/upgrade-authority.md` documents the procedure.
- **Remaining (📝 OPS):** After mainnet deploy, run `solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <SQUADS_VAULT_PDA>` for both programs (2-of-3 minimum for beta; 3-of-5 before public). Record signers in the runbook.

### P1-8 · Cargo release profile lacks `overflow-checks` — ✅ FIXED
- **File:** `Cargo.toml` (workspace, profile.release).
- **Verified:** `overflow-checks = true` set at workspace root.

### P1-9 · Verifiable build setup — ❌ OPEN
- **Tooling:** `solana-verify`.
- **Remaining:** Add Docker-based reproducible build. Document `solana-verify verify-from-repo` in `runbooks/deployment/verify.md`. Wire CI step that produces the same hash as `anchor build` locally.
- **Effort:** 4h.

### P1-10 · Root history window — ❌ OPEN
- **File:** `programs/octora-mixer/src/constants.rs:9` — `ROOT_HISTORY_SIZE = 30` (~12s mainnet).
- **Required fix:** Raise to `256` (≈100s) or `1024` (≈7min). Each root is 32 bytes, so 1024 = 32KB. Reassess account-size budget.
- **Effort:** 30min + account-size review + redeploy.

### P1-11 · CPI signer re-pinning — ✅ FIXED
- **Files:** DLMM `init_position.rs:120–123`, `add_liquidity.rs:114–118`, `claim_fees.rs:105–109`.
- **Verified:** All DLMM mutating instructions store `pa_info` via `to_account_info()` and re-inject it into the infos vector before `invoke_signed`.

### P2-12 · IDL on-chain publication — ❌ OPEN (📝 OPS)
- **Remaining:** `anchor idl init <PROGRAM_ID> --filepath <idl.json>` post-deploy.
- **Effort:** 30min.

### P0-NEW-A · Remove DAMM modules from executor program — ❌ OPEN
- **Files:** `programs/octora-executor/src/instructions/damm/` (entire subtree), any `pub mod damm;` in `lib.rs`, any DAMM types in `state/`, any DAMM CPI wrappers in `cpi/`.
- **Problem:** DAMM is no longer part of the product scope (DLMM-only). Leaving DAMM instructions and account structs compiled into the on-chain program adds attack surface for instructions that will never be exercised, will never receive negative test coverage, and may never be re-audited. Anchor still emits IDL entries for them, so any client could attempt to invoke them.
- **Required fix:** Delete `programs/octora-executor/src/instructions/damm/`, remove the module declaration from `lib.rs`, drop any DAMM-only state/CPI types, update Cargo features, regenerate IDL, rebuild. Confirm `tests/` no longer references DAMM. Re-deploy to devnet to validate; do NOT deploy to mainnet without this cleanup.
- **Effort:** 2–4h + test re-run.

### P3-NEW-B · Sysvar identity check is key-only — 📝 OPS
- **File:** `programs/octora-executor/src/cpi/mod.rs` (`require_rent_sysvar`)
- **Problem:** Only `require_keys_eq!` against `sysvar::rent::ID`. Hardcoded address makes collision infeasible, but defense in depth would also assert `!is_signer && !is_executable`.
- **Required fix (P3):** Add the two flag checks.
- **Effort:** 15min.

---

## 2. Privacy guarantees (P0–P2)

### P0-13 · Trusted setup ceremony — see P0-2.

### P0-14 · Per-deposit single denomination — ✅ FIXED + 📝 docs
- **File:** `programs/octora-mixer/src/instructions/deposit.rs`
- **Verified:** Code rejects mismatched denominations.
- **Remaining (📝 OPS):** Publish supported mainnet denominations in `runbooks/PRIVACY_MODEL.md`. Add UI guidance.

### P0-15 · Privacy delay must persist across relayer restart — ✅ FIXED
- **Files:** `octora-api/src/modules/relayer/relayer.service.ts:70–77`, `octora-api/prisma/schema.prisma:105–113` (`MixerRootSeen`).
- **Verified:** Persisted via `RootSeenRepository`; gate uses `firstSeenSlot` (BigInt, monotonic), not wall-clock.

### P0-16 · Stealth wallet encryption derivation — ✅ FIXED
- **File:** `octora-api/src/modules/relayer/stealth-wallet.ts:49–94`
- **Verified:** v3 format mixes a per-blob random nonce into the HKDF `info` parameter (`Buffer.concat([HKDF_INFO_V3_PREFIX, nonce])`). Nonce stored alongside ciphertext.
- **Follow-up (P3):** Document v2→v3 migration in user-facing recovery flow.

### P1-17 · Relayer learns recipient (inherent) — ⚠ PARTIAL
- **File:** `octora-api/src/modules/relayer/relayer.service.ts`
- **Remaining:**
  - (a) **Operational:** enforce relayer log retention <24h, encrypt at rest. Configure log rotation in production (not yet wired in `infra/docker-compose.prod.yml`).
  - (b) **Long-term (P2):** support user-submitted withdrawals (no relayer) for users who hold gas — entirely missing.
  - (c) ✅ Documented in `runbooks/PRIVACY_MODEL.md`.
- **Effort:** 4h.

### P1-18 · No batching of withdrawals (anonymity-set policy) — ❌ OPEN
- **Required fix:** Enforce `MIN_ANONYMITY_SET=20` at mixer service. Reject withdraw attempts when set is too thin; emit clear UX warning.
- **Effort:** 2h logic + UX warning.

### P2-19 · MEV / sandwich on add_liquidity — ❌ OPEN
- **Files:** `programs/octora-executor/src/instructions/dlmm/add_liquidity.rs`
- **Required fix:** Confirm slippage / `min_out` / `max_active_id` parameters are user-controlled (not hardcoded). Wire UI controls. Default 0.5% stable / 1% volatile.
- **Effort:** 2h.

### P0-NEW-I · Private exit (symmetric withdrawal) — ❌ OPEN
- **Files:** `programs/octora-mixer/`, `programs/octora-executor/src/instructions/dlmm/{withdraw_close,claim_fees}.rs`, `octora-api/src/modules/relayer/`, `octora-api/src/modules/positions/position.service.ts` (close-position path), `octora-web/` exit UX.
- **Problem:** The current product hides the **deposit** edge (main → mixer → stealth) but the **exit** edge is the inverse and on-chain visible: stealth wallet receives DLMM proceeds and then transfers to the user's main wallet, or the user manually consolidates, in either case publicly linking `stealth ↔ main`. A passive observer correlating Meteora close-position events with subsequent SOL/SPL transfers from the stealth wallet recovers the same identity link the deposit was designed to hide. Net privacy ≈ 0 over a deposit→exit cycle.
- **Required fix:** Implement a mirror-of-deposit private exit:
  - `stealth → mixer → relayer → main` (same shape as `main → mixer → stealth` on the deposit side, run in reverse).
  - On exit:
    1. After `withdraw_close` / `claim_fees` returns assets to the stealth wallet, the stealth wallet **deposits into the mixer** at the same canonical denomination (or splits across denominations).
    2. After the privacy delay (slot-based, per P0-15), the relayer (or a self-submitted path) consumes the nullifier and sends to the user's `recipient = main wallet`.
    3. Recipient/relayer/fee binding (P0-3) already covers the circuit-level constraint for this direction — same circuit, same VK, same relayer infra. No new circuit work, but the **withdrawal flow path** must support exit-side denominations (DLMM proceeds may be heterogeneous: token A + token B + reward tokens).
  - Frontend: surface "Private exit" as the default close action. Educate users that direct stealth → main transfer breaks privacy.
  - Anonymity-set policy (P1-18) applies symmetrically to exits.
  - For heterogeneous proceeds (DLMM gives back token A + token B + fees in a third token), either (a) require a swap-to-canonical step on the stealth side before mixer deposit, or (b) support per-token mixer pools for the supported pairs.
- **Sub-tasks:**
  - Backend orchestration: extend position state machine with `closing → mixer_exit_pending → relayer_dispatched → finalized` states; recovery worker covers stuck exits.
  - Mixer service: enforce that exit-side deposits accept arbitrary `recipient` (main wallet) without re-using a previously-seen `commitment`.
  - UX: dual-confirmation modal — "Direct exit (links wallet)" vs "Private exit (recommended, ~Xmin delay)".
  - Tests: e2e covering full deposit → LP → private exit → main wallet, asserting no on-chain transfer ever connects stealth to main.
  - Privacy doc: update `runbooks/PRIVACY_MODEL.md` to define the threat model on both edges; clarify what "private LP" means with vs. without symmetric exit.
- **Severity rationale:** This is the P0 the audit had been treating as implicit. Without it, every existing P0/P1 in this document only delivers half-privacy. The marketing promise ("copy-trade bots see nothing") fails the moment a user closes a position. P1-17's "support user-submitted withdrawals" partially overlaps — fold its sub-task (a) into this item; (b) of P1-17 (gasless self-submit) is still separate.
- **Effort:** 3–5 engineer-days (state machine + relayer path + UX + tests). Add 1 day if heterogeneous-asset swap-to-canonical step is included.

---

## 3. Backend — `octora-api` (P0–P2)

### P0-20 · Wallet-signature auth on mutating endpoints — ✅ FIXED
- **Files:** `octora-api/src/common/auth.ts:159` (`verifyEd25519Detached`), `octora-api/src/modules/positions/position.routes.ts:83–84` (`requireWalletSignature`, `requireBetaAccess`), `octora-api/prisma/schema.prisma:85–94` (`AuthNonce`).
- **Verified:** Ed25519 verification, one-time nonce table, atomic `updateMany`-based consumption to prevent replay.

### P0-21 · Relayer hot wallet keypair on disk — ⚠ PARTIAL (P1 mainnet blocker)
- **Files:** `octora-api/src/common/config.ts:21,65–66`, `octora-api/src/common/health.ts:95–120`, `runbooks/deployment/key-rotation.md`.
- **Verified:** Manual rotation runbook exists. Config supports `file:<path>` or inline JSON.
- **Remaining for mainnet:**
  1. Move keys off the API host. Run a separate signing service on a hardened VM, or KMS (AWS KMS / GCP Cloud HSM) accessed via mTLS.
  2. Segregate mixer-fee wallet (≤$500 float) from executor wallet.
  3. Wire balance-change alarm (>$X within Y minutes → page).
  4. Schedule 30-day rotation cadence.
- **Effort:** 1–2 days (KMS-backed signer + alarms).

### P0-22 · CORS wildcard fallback — ✅ FIXED
- **File:** `octora-api/src/common/config.ts:121–141`
- **Verified:** `loadFrontendUrl()` throws at startup in `NODE_ENV=production` if `FRONTEND_URL` is missing or `*`.

### P0-23 · Health endpoint — ✅ FIXED
- **File:** `octora-api/src/common/health.ts:40–56`, wired in `octora-api/src/app.ts:145–150`.
- **Verified:** Checks DB (`SELECT 1`), RPC (`getSlot` 2s timeout), relayer keypair file, mixer pool pause state. Returns 503 on any failure.

### P1-24 · Rate limiting — ✅ FIXED
- **Files:** `octora-api/src/modules/positions/position.routes.ts:69–74` (intent 10/min/IP, mutate 5/min/IP), `octora-api/src/modules/mixer/mixer.routes.ts` (READ 120/min, WRITE 30/min), `octora-api/src/modules/relayer/relayer.routes.ts`.
- **Follow-up (P3):** Add per-wallet keys (currently IP-keyed). IP-only is bypassable behind rotating proxies.

### P1-25 · Beta access gating — ✅ FIXED
- **Files:** `octora-api/src/common/auth.ts:175–196` (`requireBetaAccess`), `octora-api/prisma/schema.prisma:75–79` (`BetaAccess`), called from all position routes at line 83.

### P1-26 · Per-position and global TVL caps — ✅ FIXED
- **File:** `octora-api/src/common/config.ts:46–53,104–106`.
- **Verified:** `BETA_MAX_POSITION_SOL` (default 2.5), `BETA_MAX_GLOBAL_TVL_SOL` (default 125), `BETA_MAX_POSITIONS_PER_WALLET` (default 5). Configurable via env.

### P1-27 · Blockhash expiry / retry logic — ✅ FIXED
- **File:** `octora-api/src/common/solana-tx.ts:78–160`.
- **Verified:** Fresh blockhash per attempt, retry loop on transient failures, distinguishes retryable vs terminal.

### P1-28 · Compute budget and priority fees — ✅ FIXED
- **File:** `octora-api/src/common/solana-tx.ts:~130`, `octora-api/src/modules/executor/executor.service.ts`.
- **Verified:** Dynamic priority fees via `getRecentPrioritizationFees`. CU per instruction (600k–1.4M). Defaults configurable.
- **Follow-up (P2):** Cap upper-bound priority fee (audit recommended ≤0.01 SOL) to prevent fee griefing — verify the cap is wired.

### P1-29 · Recovery worker for stuck positions — ✅ FIXED
- **File:** `octora-api/src/modules/positions/recovery-worker.ts:1–100+`.
- **Verified:** Ticks every 30s, batch limit 50, reconciles `executing_on_meteora >5min`, `indexing >2min`, captures Sentry exceptions on new failures.

### P1-30 · Structured logging + Sentry — ✅ FIXED (backend) / ❌ OPEN (frontend)
- **Files:** `octora-api/src/common/observability.ts:38–68`, `octora-api/src/app.ts:74`.
- **Verified backend:** Pino JSON + ISO timestamps. Redacts `signature`, `signedMessage`, `Authorization`, `x-signed-nonce`, `x-signature`, `x-wallet-address`. Sentry is optional via `SENTRY_DSN`.
- **Remaining:** Wire frontend Sentry SDK in `octora-web/`. Strip PII (wallet addresses can be hashed before report).
- **Effort:** 2h.

### P2-31 · Database indexes — ✅ FIXED
- **File:** `octora-api/prisma/schema.prisma`.
- **Verified:** `Position.walletAddress`, `Position.[walletAddress, state]`, `Activity.[positionId, createdAt]`, `ExecutionSession.[positionId, createdAt]`, `MixerRootSeen.firstSeenAt`, `AuthNonce.[walletAddress, used]`, `AuthNonce.expiresAt`.
- **Follow-up (P3):** Run `EXPLAIN ANALYZE` on top-10 query patterns under realistic load.

### P2-32 · Database backups + WAL archival — ❌ OPEN
- **Files:** `infra/docker-compose.prod.yml`.
- **Required fix:** Production deployment uses managed Postgres (RDS / Supabase / Neon) with PITR enabled, or self-hosted with WAL archiving to S3 every 5min, daily full backup, weekly tested restore.
- **Effort:** 1 day setup; ongoing ops.

### P2-33 · OFAC / sanctions screening — ❌ OPEN
- **Problem:** No screening integration found. Privacy mixer + zero screening = significant US/EU regulatory exposure (Tornado Cash precedent).
- **Required fix:** Integrate Chainalysis or TRM Labs at deposit-side. Reject sanctioned addresses, log decisions. **OR** obtain documented legal opinion + offshore corporate structure + no US users gating.
- **Effort:** 1 day integration; weeks for legal opinion.

### P3-NEW-C · Indexer reorg handling — ❌ OPEN
- **Files:** `octora-api/src/common/solana-tx.ts:65`, `octora-api/src/modules/mixer/mixer.service.ts:65`, `recovery-worker.ts:54`.
- **Problem:** All paths use `confirmed` commitment. Solana mainnet has occasional rollbacks; positions advanced on `confirmed` slot can be reverted.
- **Required fix:** Use `finalized` for state transitions; `confirmed` only for UX optimism. On detected slot rollback, reverse affected position state and emit alert.
- **Effort:** 1 day. (Was P2-47 in revision 1.)

---

## 4. Frontend — `octora-web` (P1–P2)

### P1-34 · Default cluster — ✅ FIXED
- **File:** `octora-web/src/lib/solana/config.ts:43–61`.
- **Verified:** `loadCluster()` enforces `VITE_NETWORK`; throws in `import.meta.env.PROD` if unset/invalid.

### P1-35 · Network mismatch detection — ✅ FIXED
- **File:** `octora-web/src/lib/networkStatus.ts:38–93`, `KNOWN_GENESIS_HASHES:36–41`, `isNetworkUnsafe()`.
- **Verified:** Genesis-hash comparison; mutations blocked when `mismatch`/`rpc-error`.

### P1-36 · Beta + UNAUDITED warning UX — ✅ FIXED
- **Files:** `octora-web/src/components/octora/BetaWarningBanner.tsx`, `octora-web/src/lib/tosAck.ts:1–90`.
- **Verified:** Sticky banner; signed ToS modal with versioned message (`CURRENT_TOS_VERSION = "v1-2026-05-10"`). Re-ack on version bump.
- **Follow-up:** Persist `acknowledgedTosVersion` server-side per wallet (currently client-side LocalStorage only — verify and add server-side ack table if missing).

### P1-37 · Error boundaries + production loading/empty states — ❌ OPEN
- **Required fix:** Top-level React error boundary that reports to Sentry. Per-page boundaries for `/pools`, `/portfolio`, `/positions/:id`. Skeleton loaders, empty states.
- **Effort:** 1 day.

### P1-38 · Stealth wallet UX — ❌ OPEN
- **Files:** `octora-web/src/lib/stealthVault.ts` (exists; no surrounding UX).
- **Problem:** No pre-deposit modal explaining stealth wallet model; no export-seed feature; no documented recovery flow for users.
- **Required fix:** Pre-deposit modal explaining: stealth wallet ephemeral, signing same vault-derivation message in another browser is the only recovery, losing access loses rent + dust. Add "Export stealth wallet seed" UX.
- **Effort:** 1 day.

### P1-39 · Mock data tree-shaking — ❌ OPEN
- **Files:** `octora-web/src/data/`.
- **Required fix:** Audit `import.meta.env.DEV` branches. Add CI check that `npm run build` doesn't include `MOCK_`/`DEMO_` strings.
- **Effort:** 2h.

### P2-40 · Bundle size + CSP — ❌ OPEN
- **Required fix:** Strict CSP (no `unsafe-inline`/`unsafe-eval`; `wasm-unsafe-eval` allowed for snarkjs). SRI hashes on external scripts. Audit unused deps.
- **Effort:** 4h.

---

## 5. Infrastructure & operations (P1–P2)

### P1-41 · Production deployment story — ✅ FIXED (with caveats)
- **Files:** `infra/docker-compose.prod.yml:1–93`, `octora-api/Dockerfile:1–91`, `infra/Caddyfile:32–39`.
- **Verified:** Multi-service compose (postgres 16-alpine, octora-api, caddy reverse proxy + ACME). Multistage Dockerfile, non-root `octora` user, tini entrypoint, healthcheck. Caddyfile sets HSTS 1yr + includeSubDomains, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict.
- **Caveat:** No log-shipping configured. Static frontend hosting (Vercel/Netlify/Cloudflare Pages) decision not committed to repo.

### P1-42 · CI/CD — ✅ FIXED
- **File:** `.github/workflows/ci.yml:1–167`.
- **Verified:** API typecheck + prisma drift + tests; web typecheck + tests + build; programs cargo check + clippy; anchor build job.
- **Follow-up:** Manual approval gate to mainnet deploy not yet wired (current CI is PR-validation only).

### P1-43 · Secrets management — ⚠ PARTIAL
- **Files:** `runbooks/deployment/secrets.md`, `infra/docker-compose.prod.yml:50–55`.
- **Verified:** Manual procedure documented; production env sourced via `env_file: ./octora-api.env`.
- **Remaining:** No automated secret-rotation pipeline. Operator must pull secrets manually from Doppler / 1Password / AWS SM. Add scripted sync + 30-day rotation reminder.
- **Effort:** 4h.

### P1-44 · Monitoring + alerting baseline — ⚠ PARTIAL
- **Verified:** Sentry SDK wired (optional); Caddy access logs enabled.
- **Remaining:**
  - Frontend Sentry (see P1-30).
  - UptimeRobot / Better Uptime hitting `/health` every 60s, alert on 2 consecutive failures.
  - Custom metrics dashboard: mixer TVL, relayer wallet balance, position state distribution, withdrawal success rate.
  - PagerDuty / OpsGenie for critical alerts (relayer balance < threshold, health failure, position stuck >10min).
- **Effort:** 1 day.

### P1-45 · Incident response runbooks — ✅ FIXED
- **Files:** `runbooks/incident/{mixer-pause,stuck-position-recovery,program-bug-response,database-restore}.md`, `runbooks/deployment/key-rotation.md`.
- **Follow-up (P3):** Schedule a tabletop exercise per quarter; record latest restore drill timestamp.

### P2-46 · Public RPC will fail — ❌ OPEN (📝 OPS)
- **File:** `octora-api/src/common/config.ts:94–95,157`.
- **Problem:** Single endpoint per surface. No split between relayer (write-heavy, low-latency) and indexer (read-heavy).
- **Remaining:** Procure Helius Premium / Triton / QuickNode. Configure separate endpoints. Frontend uses CDN-cached RPC.
- **Effort:** 2h once contract is signed; 1–2 weeks procurement.

### P2-47 · Indexer reorg handling — see P3-NEW-C above.

---

## 6. Testing (P1–P2)

### P1-48 · Anchor program integration tests in CI — ⚠ PARTIAL
- **Files:** `tests/octora-mixer-security.ts`, `tests/octora-executor-dlmm-negative*.ts`, `tests/octora-executor-dlmm-edge-cases.ts`, `tests/octora-e2e-full-lifecycle.ts`, `Anchor.toml:24`, `.github/workflows/ci.yml`.
- **Verified:** Negative tests for admin gate, pause, fee validation, public-input bounds, recipient/relayer/fee mismatch (mixer); stealth mismatch, position/lb_pair integrity, token program, sysvar (executor DLMM). E2E lifecycle. CI runs `anchor build` + cargo clippy.
- **Remaining:**
  - Explicit CPI substitution attack tests (wrong program ID fails).
  - `anchor test` actually executed in CI (currently only `anchor build`).
  - Mainnet-cloned fixture accounts.
- **Effort:** 1–2 days.

### P1-49 · End-to-end test: deposit → withdraw on devnet — ✅ FIXED
- **Files:** `tests/octora-e2e-full-lifecycle.ts`, nightly smoke runbook (Day 6 commit).
- **Verified:** Nightly e2e exists per recent commit history.
- **Follow-up:** Confirm failure pages on-call (PagerDuty wiring per P1-44).

### P2-50 · Load test — ❌ OPEN
- **Required fix:** Artillery / k6 against staging API: 100 concurrent users creating intents, 10/sec mixer deposits. Verify rate limits, no DB connection exhaustion.
- **Effort:** 1 day.

---

## 7. Legal, compliance, and beta governance (P1–P2)

### P1-51 · Terms of Service + Privacy Policy + Risk Disclosure — ⚠ PARTIAL
- **Verified:** Signed ToS modal in frontend with versioned message (P1-36).
- **Remaining (📝 OPS):** Lawyer-reviewed ToS / Privacy Policy / Risk Disclosure documents. Currently the signed message is placeholder text — get a real attorney review covering: jurisdiction, dispute resolution, non-custodial framing, no warranty, smart-contract risk, ZK trusted-setup risk, relayer compromise risk, regulatory risk.
- **Effort:** Lawyer engagement; ~2 weeks.

### P1-52 · Beta cohort agreement — ❌ OPEN (📝 OPS)
- **Required deliverable:** Per-user signed letter: (a) acknowledged risk, (b) max deposit cap (mirrored server-side), (c) no recourse, (d) confidentiality if applicable, (e) bug-reporting channel.
- **Effort:** 1 day template + per-user signing.

### P2-53 · Bug bounty — ❌ OPEN
- **Required fix:** ImmuneFi or Sherlock listing before public launch. Tiered $10k / $50k / $250k.
- **Effort:** 1 week to draft + list.

### P2-54 · External security audit — ❌ OPEN (📝 OPS, 6–14 week lead)
- **Required fix:** Engage Zellic / OtterSec / Trail of Bits / Cure53 for full audit of programs + circuit + relayer. Procurement starts NOW.
- **Cost:** $40k–$120k.

---

## 8. Documentation (P1)

### P1-55 · Required docs at launch — ✅ FIXED
- **Files:** `runbooks/PRIVACY_MODEL.md`, `runbooks/ARCHITECTURE.md`, `runbooks/ceremony/PROCEDURE.md`, `runbooks/deployment/MAINNET.md`, `runbooks/deployment/upgrade-authority.md`, `runbooks/deployment/key-rotation.md`, `runbooks/deployment/secrets.md`.
- **Verified:** All present.
- **Follow-up:** Update `README.md` to remove demo-data references and clearly mark beta status (still has roadmap items marked `[ ]` for live executor / mainnet — verify alignment with reality).

---

## 9. New issues found in 2026-05-10 re-audit

### P0-NEW-A · Remove DAMM modules from executor program — see §1.

### P3-NEW-B · Sysvar identity is key-only — see §1.

### P3-NEW-C · Indexer/recovery on `confirmed` not `finalized` — see §3.

### P2-NEW-D · ToS acknowledgement client-side only — ❌ OPEN
- **File:** `octora-web/src/lib/tosAck.ts`
- **Problem:** Versioned ToS signature appears stored in LocalStorage. A wiped browser = unable to prove the user ever acknowledged. Server-side `TosAcknowledgement` table needed for audit trail.
- **Required fix:** Persist `(walletAddress, version, signature, acknowledgedAt)` in API + DB. Required preHandler check on first deposit per wallet per version.
- **Effort:** 3h.

### P3-NEW-E · `pnpm audit` / `cargo audit` not in CI — ❌ OPEN
- **File:** `.github/workflows/ci.yml`.
- **Problem:** No dependency vulnerability scanning. Workspace overrides exist (`underscore`, `uuid`, `@hono/node-server` in `package.json:496–501`) which suggests past CVE pressure — needs ongoing watch.
- **Required fix:** Add quarterly `pnpm audit --prod` + `cargo audit` job. Fail on `high`/`critical`.
- **Effort:** 2h.

### P3-NEW-F · Per-wallet rate limit (currently IP-only) — ❌ OPEN
- **Files:** `octora-api/src/modules/positions/position.routes.ts:69–74`, others.
- **Problem:** Rate limits keyed on IP. Trivially bypassed via rotating proxy. Wallet-keyed limit (after auth preHandler runs) gives a real per-actor cap.
- **Required fix:** Layer wallet-keyed limiter after `requireWalletSignature`.
- **Effort:** 2h.

### P3-NEW-G · Frontend Sentry not wired — ❌ OPEN
- See P1-30 / P1-44.

### P0-NEW-I · Private exit (symmetric withdrawal) — see §2.

### P3-NEW-H · Log retention/rotation in production compose — ❌ OPEN
- **File:** `infra/docker-compose.prod.yml`.
- **Problem:** No `logging` driver options set; default Docker JSON logs grow unbounded and contain PII despite Pino redaction (Caddy access logs may include wallet addresses in URL paths).
- **Required fix:** Configure `logging.driver: json-file` with `max-size`/`max-file`, or ship to a managed log aggregator with retention policy <24h for relayer logs (per P1-17).
- **Effort:** 1h compose change + retention policy decision.

---

## 10. Critical-path summary (today → mainnet beta)

What is **actually outstanding** before the first invited user puts mainnet SOL into the mixer:

### Must complete pre-deploy (📝 OPS, blocking)

| ID | Item | Owner | Lead time |
| --- | --- | --- | --- |
| P0-1 | Replace `ADMIN_AUTHORITY` placeholder with Squads vault PDA | Eng | 1 day |
| P0-2 | Run multi-party trusted setup ceremony, publish transcripts | ≥3 contributors | 1–3 days |
| P0-6 | Fill `[programs.mainnet]` after deploy with fresh keypairs | Eng | 30min |
| P1-7 | Transfer upgrade authority to Squads multisig | Eng + signers | 2h |
| P2-12 | `anchor idl init` post-deploy | Eng | 30min |
| P2-46 | Procure dedicated mainnet RPC (Helius/Triton/QuickNode) | Ops | 1–2 weeks |

### Must complete in-code (P0/P1 still ❌ OPEN)

| ID | Item | Effort |
| --- | --- | --- |
| P0-NEW-A | Delete DAMM modules (`programs/octora-executor/src/instructions/damm/`) and rebuild | 2–4h |
| P0-NEW-I | Symmetric private exit (stealth → mixer → relayer → main) — restores promised privacy on the close-position edge | 3–5 days |
| P0-21 | Move relayer keypair off API host (KMS / signing service) + balance alarms + segregation | 1–2 days |
| P1-9 | Verifiable build (`solana-verify`) + docs | 4h |
| P1-10 | Raise `ROOT_HISTORY_SIZE` from 30 to ≥256 | 30min |
| P1-17 | Relayer log retention <24h + encrypted at rest | 4h |
| P1-18 | Anonymity-set minimum (`MIN_ANONYMITY_SET=20`) gate | 2h |
| P1-30 (frontend) | Frontend Sentry SDK + redaction | 2h |
| P1-37 | React error boundaries per page | 1 day |
| P1-38 | Stealth wallet UX (pre-deposit modal + export-seed) | 1 day |
| P1-39 | Mock-data tree-shake + CI check | 2h |
| P1-43 | Secrets-management automation + 30-day rotation | 4h |
| P1-44 | Frontend Sentry + UptimeRobot + PagerDuty + custom metrics | 1 day |
| P1-48 | CPI-substitution tests + `anchor test` in CI + mainnet-cloned fixtures | 1–2 days |
| P1-51 | Lawyer-reviewed ToS / Privacy Policy / Risk Disclosure | ~2 weeks |
| P1-52 | Beta cohort agreement letter + per-user signing | 1 day + ops |
| P2-NEW-D | Server-side ToS acknowledgement table | 3h |

### Total remaining engineer-time before private beta

Roughly **12–17 engineer-days** of code work (revised up to include P0-NEW-I private-exit implementation) + **2–3 weeks** of legal/ops lead-time (ceremony, ToS, RPC procurement, Squads setup).

---

## 11. Required before public launch (P2)

After private beta is live and stable for ≥30 days:

| ID | Item |
| --- | --- |
| P2-19 | MEV/slippage UI controls confirmed |
| P2-32 | Managed Postgres with PITR or self-hosted WAL archival + tested restore |
| P2-33 | OFAC / sanctions screening integration (or documented legal posture) |
| P3-NEW-C | Indexer/recovery on `finalized` + reorg rollback |
| P2-40 | Strict CSP, SRI, bundle audit |
| P2-50 | Load test (100 concurrent, 10/sec deposits) |
| P2-53 | Bug bounty live (ImmuneFi / Sherlock) |
| P2-54 | External audit complete (Zellic / OtterSec / TrailOfBits / Cure53) |

---

## 12. Out of scope (do not attempt at this stage)

- Cross-chain functionality
- Mobile app
- Token launch / airdrop
- Aggressive marketing
- Fee accrual to a treasury (until ToS + entity is set up)
- Anything that increases attack surface without first-class test coverage

---

## 13. Audit ledger

| Date | Auditor | Scope | Outcome |
| --- | --- | --- | --- |
| 2026-05-09 | Internal (revision 1) | Full repo | 55 items recorded; Days 1–7 work scheduled |
| 2026-05-10 | Internal (revision 2 — this doc) | Full re-audit after Days 1–7 commits + ceremony + circuit binding | 33 items confirmed FIXED; 22 OPEN; 8 new findings (NEW-A through NEW-H) |
| 2026-05-10 | Internal (revision 3 — addendum) | Privacy-symmetry gap on the exit edge | 1 new P0 finding (NEW-I — private exit / symmetric withdrawal) |
| 2026-05-10 | Internal (revision 4 — implementation log) | Plan 1 of `docs/plans/meteora-swap-layer/` landed: `dlmm_swap` ix + 2 new errors (`SwapSlippageExceeded`, `SwapSourceEqualsTarget`) + negative test suite. Audit surface: `programs/octora-executor/src/instructions/dlmm/swap.rs` (pause-gated, balance-delta slippage, no PDA signers — uses plain CPI invoke). | New CPI surface registered in IDL as `dlmm_swap` (codes 6025–6026). Backend (Plan 2) and frontend (Plan 3) still pending. |
| 2026-05-10 | Internal (revision 5 — implementation log) | Plan 2 of `docs/plans/meteora-swap-layer/` landed: state machine extended with `swap_pending → swap_executing → swap_indexing` (and `swap-failed` failure stage); `ExecutionSession` swap-leg columns + Prisma migration `20260510130000_swap_layer`; `executor/swap.service.ts` (validation), `executor/swap-pool-resolver.ts` (recommends non-target SOL-paired source), `executor/clients/dlmm-swap.client.ts` (unsigned tx builder); `EXECUTOR_SWAP_ENABLED` feature flag; recovery worker reconciles `swap_executing` stuck for >5 min; intent body schema + controller + position service all gated. 24 new vitest cases pass; full octora-api suite (125 tests) green; typecheck clean. | Frontend (Plan 3) and rollout (Plan 4) still pending. Plan 2 is feature-flagged OFF by default — no behavior change in production until `EXECUTOR_SWAP_ENABLED=true`. |
| 2026-05-10 | Internal (revision 6 — implementation log) | Plan 3 of `docs/plans/meteora-swap-layer/` landed: backend `GET /dlmm/pools/:address/swap-source` endpoint (404 SOL-paired short-circuit, 422 no-source, 200 + recommendation); frontend `lib/api/swap.ts` typed client (with `computeMinAmountOut` + slippage caps mirroring backend), `useSwapSource` React Query hook, `SwapPreview` + `SwapSourceSelector` components, `SwapPathBadge` for inline pool listings, `lib/positionStateLabels.ts` for the new swap states; ToS bumped to `v2-2026-05-10` with explicit swap-step disclosure; `e2e/lp-with-swap.spec.ts` Playwright stubs covering SOL-paired short-circuit, recommend-OK, and 422 paths. Web typecheck + build clean (2733 modules); octora-api typecheck + 125 vitest cases still green. | Plan 4 (rollout) is the only remaining work. The new swap UI is staged but not yet wired into `PrivateDepositModal`'s flow — Plan 4 inserts the swap step between the relayer-funded stealth and the `init_position` CPI. |
| 2026-05-10 | Internal (revision 7 — implementation log) | Plan 4 of `docs/plans/meteora-swap-layer/` partially landed (code/CI/docs scope): per-wallet allowlist `BetaAccess.swapEnabled` + Prisma migration `20260510140000_betaaccess_swap_enabled`; controller-layer 403 reject when intent has swap step but per-wallet flag is off; CI workflow extended with DAMM-regression-count guard (soft until P0-NEW-A) and Playwright `lp-with-swap.spec.ts` registered in nightly e2e; full audit pack at `docs/plans/meteora-swap-layer/audit-pack.md` (threat model, account-validation matrix, fuzz suggestions, sign-off table); `runbooks/incident/swap-failure.md` (P0/P1/P2 triage tree, mitigation tiers, rollback path); `runbooks/PRIVACY_MODEL.md` §8b documents the swap-edge observability; `runbooks/ARCHITECTURE.md` §5/§5b carries the new swap-branch state diagram + data-flow; `runbooks/deployment/MAINNET.md` §9 lists `EXECUTOR_SWAP_ENABLED=false` as Phase-D mainnet env; `README.md` "Pool support" subsection. octora-api typecheck + 125 vitest tests pass; octora-web typecheck + 23 unit tests + production build all green. | Operational tasks (Phase A localnet smoke, Phase B 7-night devnet shakedown, Phase C external review of the audit pack, Phase D actual mainnet flip with the flag OFF, Phase E per-wallet allowlist promotion, Phase F default-on) remain — they are calendar / deploy / audit work, not code. The path is unblocked: every code- and infra-side prerequisite for the rollout is now committed. |
| TBD | External (P2-54) | Programs + circuit + relayer | Required before public launch |

---

## 14. Open-items dashboard

**Code-blocking:** P0-NEW-A, P0-NEW-I, P0-21, P1-9, P1-10, P1-17, P1-18, P1-30 (frontend), P1-37, P1-38, P1-39, P1-43, P1-44, P1-48, P2-NEW-D, P3-NEW-E/F/G/H.

**Ops-blocking (📝 OPS):** P0-1 (key swap), P0-2 (ceremony execution), P0-6 (mainnet IDs), P1-7 (Squads transfer), P2-12 (IDL publish), P2-46 (RPC contract), P1-43 (secrets sync), P1-51 (legal docs), P1-52 (cohort agreements).

**Public-launch blockers (P2):** P2-19, P2-32, P2-33, P3-NEW-C, P2-40, P2-50, P2-53, P2-54.

If every code-blocking item is closed and every 📝 OPS item is executed, Octora is **defensible for a small invited cohort with clear caps and warnings**. The product is *not* ready for unauthenticated public traffic until the §11 list is closed.
