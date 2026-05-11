# Octora — 3-week MVP launch plan

**Target:** private mainnet beta with hand-picked testers, three mixer pools (0.1, 1, 10 SOL), symmetric private exit shipped, no fund-loss or fund-lock vulnerabilities.

**Source of truth for findings:** `runbooks/PRODUCTION_READINESS.md` rev 3 (2026-05-10). This plan sequences those items into a launch schedule.

**Manual setup runbooks:** `runbooks/manual-setup/00_SETUP_OVERVIEW.md` indexes the parallel ops track.

---

## 0. Constraints accepted from this conversation

| Decision | Choice |
| --- | --- |
| Launch window | 3 weeks (15 working days) |
| Private exit P0-NEW-I | In scope — symmetric exit shipped, marketing claim holds |
| Multi-denomination | Three pools: 0.1 SOL, 1 SOL, 10 SOL |
| Cohort | Closed beta — signed agreement, capped TVL, no public marketing |

## 1. Resourcing reality check — read this first

The audit estimates 12–17 engineer-days of remaining code work. Your accepted scope adds the private-exit work (3–5 days, already in that range) and multi-denomination UX/policy (~2 days, not in the original estimate). Ops parallel track adds ~3 days of human time for ceremony coordination, KMS setup, Squads setup, lawyer review.

**With one engineer:** the in-code path is feasible only if the ops track is owned by someone else (you). One engineer doing both will slip 1–2 weeks. Strongly recommend either two engineers (one full-stack TypeScript, one Solana/Rust) or extending the timeline to 4 weeks.

**With two engineers:** comfortable. Split is "one owns programs + relayer, one owns API + frontend." Ceremony and ops are in parallel and run by you with the runbooks in `runbooks/manual-setup/`.

**Lawyer engagement is two-week lead time** — engage Day 1 regardless of engineering split.

## 2. Explicit deferrals — what is NOT in beta and the mitigation

| Deferred item | Severity | Mitigation for beta | When to revisit |
| --- | --- | --- | --- |
| OFAC / sanctions screening (P2-33) | P2 | Geographic restriction in ToS + Cloudflare country block (no US/sanctioned jurisdictions). Documented legal opinion required from lawyer (covered in `05_LEGAL_TOS_BETA.md`). | Before public launch |
| External security audit (P2-54) | P2 | Procurement contract signed Week 1; audit lands 6–14 weeks post-engagement. Beta runs in parallel with capped TVL. | Mandatory before public launch |
| Bug bounty (P2-53) | P2 | Internal disclosure email + tester reporting channel from beta agreement. | 30 days post-beta |
| Indexer reorg handling (P3-NEW-C) | P3 | Accepted risk — TVL caps make a worst-case reorg loss bounded. Recovery worker + manual operator support during beta. | First post-beta sprint |
| Database PITR (P2-32) | P2 | Daily snapshot to S3 + WAL archived hourly during beta. PITR before public. | Before public launch |
| Bundle CSP (P2-40) | P2 | Caddyfile already sets HSTS / X-Frame-Options / X-Content-Type-Options. Strict CSP follows. | First post-beta sprint |
| Load test (P2-50) | P2 | Beta cohort small enough that real-traffic load test is the test. Capacity review at 70% TVL cap. | Before opening signups |
| Sysvar identity defense-in-depth (P3-NEW-B) | P3 | 15-minute fix; can land any time. Schedule for Day 12. | Within beta |
| User-submitted withdrawals (gas-paid by user) (P1-17b) | P1-extension | Relayer-only path is shipped. Self-submit is a privacy boost, not a safety boost. | First post-beta sprint |

Everything else from `runbooks/PRODUCTION_READINESS.md` ships before beta open.

## 3. Week-by-week plan

Each day shows engineer A (programs + relayer + ops), engineer B (API + frontend), and operator (you). If you have one engineer, they cover A's items in week 1, B's in weeks 2–3.

### Week 1 — Foundation hardening + multi-pool plumbing

**Day 1 (Mon)** — kickoff

Engineer A:
- `P0-NEW-A` Delete `programs/octora-executor/src/instructions/damm/`, drop `pub mod damm;` from `lib.rs`, remove DAMM types from `state/` and `cpi/`, regenerate IDL, rebuild. Confirm `tests/` no longer references DAMM. Devnet redeploy. ~3 h.
- `P1-10` Raise `ROOT_HISTORY_SIZE` from 30 to 256 in `programs/octora-mixer/src/constants.rs`. Update `MixerPool::SPACE` math, redeploy on devnet, confirm existing tests pass with the new ring. ~1 h.
- Multi-pool init script — extend `scripts/` so the deploy script seeds three `MixerPool` accounts (denominations `100_000_000`, `1_000_000_000`, `10_000_000_000` lamports). ~2 h.

Engineer B:
- `P1-39` Mock-data tree-shake — audit `octora-web/src/data/` for `import.meta.env.DEV` branches; add CI grep guard that production build contains no `MOCK_` / `DEMO_` / `SAMPLE_` strings. ~2 h.
- Multi-denomination selector wireframe + state in `PrivateDepositModal.tsx`. Three pills (0.1, 1, 10 SOL); validation; show selected denomination in confirmation. ~3 h.
- Per-pool anonymity-set fetch — extend `/mixer/pools` endpoint contract (engineer A wires server side Day 2). ~1 h.

Operator (you):
- Engage lawyer (`05_LEGAL_TOS_BETA.md`). Send the brief, confirm 2-week turnaround.
- Open RFP / contracts with Helius, Triton, QuickNode (`04_RPC_PROCUREMENT.md`).
- Reach out to ≥3 trusted setup ceremony contributors and confirm a Day 11 slot (`02_TRUSTED_SETUP_CEREMONY.md`).
- Begin external audit procurement — RFQ to Zellic, OtterSec, Trail of Bits, Cure53. Budget $40 k–$120 k.
- Squads multisig signer key generation kickoff (`01_SQUADS_MULTISIG.md`).

**Day 2 (Tue)** — anonymity gate + multi-denom server

Engineer A:
- `P1-18` Implement `MIN_ANONYMITY_SET=20` enforcement at `octora-api/src/modules/mixer/mixer.service.ts`. Per-pool counter from on-chain `next_leaf_index − active nullifier count`. Reject withdraw attempts when set is too thin; emit clear error code `ANONYMITY_SET_TOO_THIN` with current/required counts. ~3 h.
- `/mixer/pools` endpoint returning `[{ denomination, anonymitySet, depositCount, withdrawalCount, isPaused }]`. ~2 h.
- Per-pool root-seen tracking — confirm `MixerRootSeen` already keys by root (it does); no schema change needed. Verify test coverage. ~1 h.

Engineer B:
- Multi-denomination selector live data — fetch `/mixer/pools`, gray out / warn on thin pools, surface `MIN_ANONYMITY_SET` shortfall. ~3 h.
- Pre-deposit anonymity warning modal: "this pool has N deposits, minimum 20 required for withdraw." ~2 h.
- `P1-30` Frontend Sentry SDK install + init — `octora-web/src/main.tsx`. Hash wallet addresses before report (use `crypto.subtle.digest`, first 8 hex chars). ~2 h.

Operator:
- KMS architecture decision (`03_RELAYER_KMS.md`): AWS KMS vs GCP Cloud HSM vs separate signing VM. Recommend AWS KMS with custom key + IAM-scoped sign permission for fastest path.
- Provision the KMS key (or signing VM if you go that route).

**Day 3 (Wed)** — verifiable build + KMS signer

Engineer A:
- `P1-9` Verifiable build — Dockerfile reproducing exact toolchain (`solana-cli@1.18.x`, `anchor@0.30.x`, `rust@1.79`). Document `solana-verify verify-from-repo` in `runbooks/deployment/verify.md`. CI job that produces same hash as local `anchor build`. ~4 h.
- `P0-21` (engineer side) KMS-backed signer — adapter pattern in `octora-api/src/common/solana-tx.ts`. Replace direct file-keypair load with `KmsSignerAdapter` when `RELAYER_SIGNER_KIND=kms`. AWS KMS uses `@aws-sdk/client-kms` `Sign` with `MessageType=DIGEST`. ~3 h.

Engineer B:
- `P1-37` React error boundaries — top-level boundary in `App.tsx` reporting to Sentry + per-page boundaries for `/pools`, `/portfolio`, `/positions/:id`. ~3 h.
- Skeleton loaders + empty states for the same pages. ~2 h.
- `P1-38` Stealth wallet pre-deposit modal — explain ephemeral model, "signing same authorize message in another browser is the only recovery", losing access loses rent + dust. ~2 h.

Operator:
- Squads vault PDA derived (`01_SQUADS_MULTISIG.md`). Record address.
- Update `programs/octora-mixer/src/constants.rs` `ADMIN_AUTHORITY` placeholder constant — engineer A applies the change + rebuilds devnet.
- Same for `programs/octora-executor/src/state/config.rs` initial authority.

**Day 4 (Thu)** — stealth UX + secrets pipeline

Engineer A:
- KMS signer integration tests against AWS KMS in `us-east-1`. Round-trip a signed test transaction on devnet. ~3 h.
- Mixer-fee wallet vs executor-relayer wallet segregation: separate KMS keys (`octora-mixer-fee`, `octora-executor-relayer`). Update config to load both. ~2 h.
- Balance-change alarm: CloudWatch on KMS-key-controlled account balance, threshold `< 0.5 SOL` or `> 50% drop in 10 min` → SNS → PagerDuty (operator wires the SNS-PD link Day 9). ~1 h.

Engineer B:
- `P1-38` Stealth wallet — export-seed UX. Modal that re-runs the authorize message and surfaces the derived seed words for the user to back up. Warn that anyone with the message + main wallet sig recovers it. ~3 h.
- `P2-NEW-D` Server-side ToS acknowledgement — Prisma model `TosAcknowledgement(walletAddress, version, signature, acknowledgedAt)`, `POST /auth/ack-tos` endpoint, preHandler check on first deposit per wallet per version. ~3 h.
- `P3-NEW-F` Per-wallet rate limit — fastify-rate-limit keyed on `req.walletAddress` after `requireWalletSignature` runs. ~2 h.

Operator:
- `P1-43` Secrets pipeline (`07_SECRETS_MANAGEMENT.md`). Doppler recommended for fastest setup. Create environments (dev, staging, prod), populate, install Doppler CLI on the production VM, wire `docker compose` to read secrets via Doppler.
- `P3-NEW-H` Configure `logging.driver: json-file` with `max-size: 10m`, `max-file: 3` in `infra/docker-compose.prod.yml`. Engineer A applies the change.

**Day 5 (Fri)** — Week 1 verification gate

Engineer A:
- Devnet end-to-end smoke: deposit into each of three pools, withdraw via relayer using KMS-backed signer, confirm anonymity-set gate kicks in below 20.
- Run `cargo audit` + add to CI as part of `P3-NEW-E`. Fail on `high` / `critical`. ~1 h.
- Code review of all Week 1 changes. Tag commit `week-1-checkpoint`.

Engineer B:
- Frontend E2E (Playwright) covering: select denomination → deposit → see anonymity warning → withdraw via relayer → see Sentry breadcrumb on simulated error → ToS modal → server-side ack persisted. ~3 h.
- `pnpm audit --prod` added to CI as part of `P3-NEW-E`. ~30 min.
- Code review.

Operator:
- Squads multisig fully provisioned, signers tested on devnet by signing a no-op upgrade.
- Lawyer first draft of ToS / Privacy / Risk Disclosure expected mid-Week 2.
- RPC contract signed with chosen provider; staging endpoints live.
- Verify trusted-setup ceremony contributors + Day 11 slot booked.

**Week 1 exit criteria** (must all be green to enter Week 2):
- All P0 in-code (except P0-NEW-I) closed and tested on devnet.
- KMS signer round-trips on devnet.
- Three mixer pools initialized on devnet, anonymity gate enforced.
- Frontend ToS ack persisted server-side.
- Sentry receiving events from both backend and frontend.
- CI is green including `cargo audit`, `pnpm audit`, anchor build, anchor test.

### Week 2 — Private exit (P0-NEW-I) + observability

**Day 6 (Mon)** — private exit state machine

Engineer A:
- Extend position state machine in `octora-api/src/domain/state-machine.ts` with `closing → mixer_exit_pending → relayer_dispatched → finalized`. Update transition guards. ~3 h.
- Mixer service: accept exit-side deposits — same `mixer.deposit` instruction, but the off-chain accounting must not double-count against the user's `BetaAccess` cap. Add `isExitDeposit: boolean` flag on the deposit-tx-build path; do not increment user's TVL counter. ~2 h.
- Recovery worker coverage for `mixer_exit_pending` (>5min unconfirmed) and `relayer_dispatched` (>2min). ~2 h.

Engineer B:
- Frontend exit UX scaffold — `PrivateExitModal.tsx` with two-step confirmation: (a) "we will move your LP proceeds back through the mixer to your main wallet, ~10 minutes," (b) "OR direct exit, which publicly links this stealth to your main wallet." ~3 h.
- Position detail page — replace single "Close" CTA with "Private exit (recommended)" + "Direct exit" link styled as warning. ~2 h.
- Per-position state badges for the new states. ~1 h.

Operator:
- Confirm KMS keys are funded with sufficient SOL on mainnet (estimate from devnet usage: 0.05 SOL per withdraw × expected daily volume).
- Lawyer: provide them with `runbooks/PRIVACY_MODEL.md` so the Risk Disclosure correctly describes the privacy boundaries (especially the symmetric-exit promise).

**Day 7 (Tue)** — heterogeneous-asset handling

Engineer A:
- **Decision:** swap-to-canonical via Meteora DLMM is the MVP path (avoids deploying per-token mixer pools, and avoids introducing Jupiter as a new external dependency). Stealth wallet swaps DLMM proceeds (token A + token B + reward tokens) to SOL by routing through SOL-paired Meteora DLMM pools other than the LP target. The codebase already has the seam — `octora-api/src/modules/executor/swap.service.ts` + `swap-pool-resolver.ts` + `DlmmSwapClient` — wired to Meteora. We're extending it, not rebuilding.
- Extend `octora-api/src/modules/executor/swap.service.ts` for the exit direction — chain Meteora DLMM swaps for each non-SOL token returned by `withdraw_close`. **Amend `recommendSwapSource` to accept `allowSameTargetFallback: boolean`** — true on exit (required for meme coin pairs, which usually have only one SOL-paired Meteora pool = the LP target), false on deposit-side (no entry swap exists in MVP single-sided SOL flow anyway). The resolver's preference order: deepest non-target SOL-paired pool, then LP target as labeled fallback, then `NoSwapSourceAvailableError`. Stealth wallet signs each swap leg. ~4 h.
- Slippage cap from `dlmm_config.jsonc` plus `MAX_SLIPPAGE_BPS=2000` already in `swap.service.ts`. **Default 5 % for meme coin pools** (matches our degen-LP target user); 1 % only for stable-paired pools. With same-pool fallback enabled, the meme coin itself almost always has a swap path. Remaining `NoSwapSourceAvailableError` cases are reward tokens with no SOL-paired Meteora pool anywhere — those remain stranded at the stealth wallet and surface in the dust panel. ~1 h.

Engineer B:
- Wire exit modal to backend orchestration: call `POST /positions/:id/private-exit` which orchestrates `withdraw_close → swap → mixer.deposit → wait → relayer.withdraw`. ~3 h.
- Progress UI per state: "withdrawing from DLMM" → "swapping to canonical" → "mixing (estimated wait: Nm)" → "submitting exit" → "complete." ~2 h.
- Toast / activity log entries for each transition. ~1 h.

Operator:
- Sentry projects created, DSNs added to Doppler, dashboards configured (use Sentry's auto-issue dashboards as starting point).

**Day 8 (Wed)** — exit-side anonymity policy + dual confirmation

Engineer A:
- `P1-18` Apply anonymity-set policy symmetrically to exit deposits. Block exit deposits when the destination pool would not provide an anonymity set ≥ 20 at withdraw time (forward-looking projection). ~2 h.
- `P2-19` Slippage / `min_out` / `max_active_id` user-controlled on `add_liquidity` and the exit swap. Default 0.5 % stable / 1 % volatile, surfaced in UI. Reject server-side if user passes outside `[0, 5 %]`. ~3 h.
- Exit-side denomination selection — if user position value falls between two denominations (e.g., 4 SOL in a position closes to 3.7 SOL after fees), spec what happens. MVP: floor to nearest denomination, dust transfers directly to main with a clear UI warning that the dust portion is not private. ~2 h.

Engineer B:
- Slippage UI controls — slider 0.1 – 20 % (matches `MAX_SLIPPAGE_BPS=2000`), **default 5 % for meme-coin pools** (1 % for stable-paired pools, if any). The slider previews TWO numbers next to it: "Estimated to receive: X SOL" (mid-market post-fee) and "Minimum guaranteed: Y SOL" (after slippage protection). Do NOT use Meteora's "Price Impact %" metric for the displayed value — its math excludes slippage protection and gives a misleadingly tight number. Show the two-line version everywhere a swap is previewed. ~2 h.
- Dust warning UX — clear warning that residual dust below smallest pool denomination links the stealth to main. Default behavior: hold dust in stealth wallet (user can sweep manually). ~2 h.
- `P1-44` Custom metrics endpoint — `/metrics` JSON adds `anonymitySetPerPool`, `withdrawalSuccessRate`, `relayerBalance`. ~2 h.

Operator:
- Lawyer ToS draft expected today. Review and round-trip.
- PagerDuty account provisioned (`06_MONITORING_ALERTING.md`). Wire SNS → PagerDuty for KMS balance alarms.

**Day 9 (Thu)** — monitoring wiring + edge cases

Engineer A:
- `P1-44` UptimeRobot or Better Uptime hitting `/health` every 60 s, alert on 2 consecutive failures → PagerDuty. ~1 h.
- Edge case: relayer KMS unavailable mid-withdraw — withdraw is in-flight, signature complete, submission fails. Implement retry with idempotency key (the on-chain nullifier PDA is the natural idempotency token; if it already exists, the withdraw landed). ~3 h.
- Edge case: stealth wallet signing fails mid-private-exit (browser closed). Recovery worker must surface a "your exit is partially complete, sign here to continue" affordance via persistent state in `ExecutionSession.swap*` columns + new `exitAttemptCount`. ~3 h.

Engineer B:
- Custom metrics dashboard in Grafana (or Sentry custom dashboard) showing the panels listed in `06_MONITORING_ALERTING.md`. ~3 h.
- Status page (statuspage.io free tier or self-hosted) with components: Web, API, Relayer, Mixer pools per denomination. Auto-update from `/health`. ~2 h.
- E2E for partial-exit recovery — kill browser mid-private-exit, reload, confirm UI offers continuation. ~2 h.

Operator:
- Beta cohort agreement template (`05_LEGAL_TOS_BETA.md`) finalized with lawyer.
- Identify final beta tester list (target 5–15 testers for first cohort).

**Day 10 (Fri)** — Week 2 verification gate

Engineer A + B + operator:
- Full devnet dress rehearsal of private exit:
  1. Create a position into each denomination pool.
  2. Add liquidity, claim fees, accumulate state.
  3. Trigger private exit, walk through all states.
  4. Assert (via `solana-explorer` graph traversal in test) that no on-chain transfer connects stealth → main outside the mixer path.
  5. Re-run with deliberate failures (kill API mid-flow, kill browser, RPC degrade).
- Tag commit `week-2-checkpoint`.

**Week 2 exit criteria:**
- Private exit fully wired and tested on devnet end-to-end.
- Anonymity-set gate enforced symmetrically.
- Slippage controls user-adjustable, server-side bounded.
- Sentry, UptimeRobot, PagerDuty, dashboards all live in staging.
- Recovery worker handles partial exits.
- ToS lawyer draft signed off internally.

### Week 3 — Verification + ceremony + mainnet deploy

**Day 11 (Mon)** — trusted-setup ceremony

Operator (lead) + ≥3 contributors:
- Execute Phase 2 ceremony per `runbooks/manual-setup/02_TRUSTED_SETUP_CEREMONY.md` and `runbooks/ceremony/PROCEDURE.md`.
- Each contributor downloads the prior `.zkey`, runs `snarkjs zkey contribute`, publishes the new `.zkey` hash + `r1cs` hash + entropy attestation.
- Final `.zkey` derivation; transcripts committed to `runbooks/ceremony/`.

Engineer A:
- Re-derive on-chain VK from final `.zkey`. Replace the hardcoded VK bytes in `programs/octora-mixer/src/verifier/groth16.rs`.
- Rebuild programs locally.
- Run all mixer security tests against the new VK; confirm test proofs verify.

Engineer B:
- `P1-48` Add CPI substitution attack tests — wrong DLMM program ID, wrong event authority, wrong sysvar. Tests must fail to land. ~3 h.
- Add `anchor test` to CI matrix (currently only `anchor build`). ~2 h.

**Day 12 (Tue)** — final hardening

Engineer A:
- `P3-NEW-B` Add `!is_signer && !is_executable` checks to `require_rent_sysvar` and similar sysvar identity checks. ~30 min.
- `P3-NEW-C` Indexer reorg posture decision — for beta, accept `confirmed` for state transitions but tag positions with the slot they advanced at, and flag any position whose tx was reverted in the recovery worker. Document the residual risk for ToS. ~2 h.
- Mainnet-cloned fixture accounts for negative tests (`P1-48` final piece). Pull a real DLMM `lb_pair` account, freeze in a fixture, run the full negative test matrix. ~3 h.

Engineer B:
- Final UI polish: error message copy review, beta-warning banner final text, ToS modal text matches lawyer document.
- Confirm `VITE_NETWORK=mainnet-beta` build succeeds and throws if env unset (already shipped, re-verify).

Operator:
- Lawyer final ToS / Privacy / Risk Disclosure delivered.
- Beta tester agreements drafted from template, ready to send.
- Squads multisig final check — perform a no-op test transaction (set admin to itself) on devnet to verify signing flow works with all signers.

**Day 13 (Wed)** — devnet final dress rehearsal + tabletop

All:
- Wipe staging, re-deploy from scratch following `08_MAINNET_DEPLOY_DAY.md` exactly. Time the deploy. Catch any missed step.
- Tabletop incident drills: `mixer-pause` (operator pages signers, signs pause tx), `stuck-position-recovery` (engineer walks through recovery worker manual override), `key-rotation` (operator rotates a KMS key, engineer confirms relayer picks up the new key without restart).
- Drill a private exit + intentional failure scenario, walk through tester support flow.
- Tag commit `week-3-rc`.

**Day 14 (Thu)** — mainnet deploy

Operator (lead) per `08_MAINNET_DEPLOY_DAY.md`:
- Build verifiable mainnet binaries.
- Generate fresh program-id keypairs offline; record keypair hashes.
- Deploy `octora-mixer` with deployer wallet; record program ID + deploy signature.
- Deploy `octora-executor`; same.
- Initialize executor `Config` with Squads vault PDA as authority.
- Initialize three mixer pools (0.1, 1, 10 SOL).
- `anchor idl init` for both programs.
- Transfer upgrade authority for both programs to Squads vault PDA.
- Update `Anchor.toml` `[programs.mainnet]` block in the same commit as the deploy signatures.
- Smoke-test: deposit + withdraw on each pool with team wallets only.

Engineer A: standby for hot-fix.
Engineer B: standby for hot-fix; mainnet build of `octora-web` deployed to production hosting.

**Day 15 (Fri)** — beta open

Operator:
- Send beta agreement to chosen testers; collect signatures.
- For each signed tester: `POST /admin/waitlist/approve` — adds to `BetaAccess` table.
- Confirm TVL caps in production env: `BETA_MAX_POSITION_SOL=2.5`, `BETA_MAX_GLOBAL_TVL_SOL=125`, `BETA_MAX_POSITIONS_PER_WALLET=5`.
- Send tester onboarding email with beta URL, ToS link, support channel.
- First-cohort window opens.

Engineer A + B:
- War room first 4 hours of beta.
- Watch Sentry, UptimeRobot, custom dashboard.
- Be ready to pause via Squads if anything looks off.

**Week 3 exit criteria (= launch criteria):**
- Mainnet binaries verifiable (anyone can rebuild from repo + tag and match hash).
- VK on-chain matches final ceremony output (verified by an outside contributor).
- Squads holds upgrade authority for both programs.
- All KMS keys funded; all monitors green.
- ToS / Privacy / Risk Disclosure live; beta tester signatures collected.
- Three pools initialized; team smoke test passed.
- Status page live, support channel monitored.

## 4. Detailed checklist of every code item

This is the comprehensive list. Each item is either ✅ already done in the codebase, ⚠ partial (work in this plan), or ❌ to-do (work in this plan). Pulled from `runbooks/PRODUCTION_READINESS.md` and ordered by file area.

### 4.1 `programs/octora-mixer/`

- ✅ `P0-1` Permissionless init guarded by feature flag (replace `ADMIN_AUTHORITY` constant Day 3).
- ⚠ `P0-2` Trusted setup verified on Day 11.
- ✅ `P0-3` Recipient/relayer binding via `paramsBinding = Poseidon(3)`.
- ❌ `P1-9` Verifiable build — Day 3.
- ❌ `P1-10` Raise `ROOT_HISTORY_SIZE` to 256 — Day 1.
- ❌ `P1-18` Anonymity-set policy enforced at service layer — Day 2.
- ❌ Multi-pool init script + per-denomination seed — Day 1.

### 4.2 `programs/octora-executor/`

- ✅ `P0-4` Stealth signer constraints.
- ✅ `P0-5` Pause via `Config.paused`.
- ✅ `P1-11` CPI signer re-pinning.
- ❌ `P0-NEW-A` Delete DAMM modules — Day 1.
- ❌ `P3-NEW-B` Sysvar identity check — Day 12.
- ❌ `P2-19` User-controlled slippage / `min_out` / `max_active_id` — Day 8.

### 4.3 `octora-api/`

- ✅ `P0-20` Wallet-signature auth.
- ✅ `P0-22` CORS not wildcard in prod.
- ✅ `P0-23` Health endpoint covers DB / RPC / relayer / mixer-paused.
- ✅ `P1-24` Rate limiting (extend per-wallet Day 4).
- ✅ `P1-25` Beta access gating.
- ✅ `P1-26` TVL caps.
- ✅ `P1-27` Blockhash retry.
- ✅ `P1-28` Compute budget + priority fees (cap upper bound Day 8).
- ✅ `P1-29` Recovery worker.
- ⚠ `P1-30` Backend Sentry shipped; frontend Day 2.
- ⚠ `P1-43` Secrets management — Day 4.
- ⚠ `P1-44` Monitoring + alerting — Days 8–9.
- ❌ `P0-21` Relayer KMS-backed signer — Days 3–4.
- ❌ `P0-NEW-I` Private exit state machine + service — Days 6–9.
- ❌ `P2-NEW-D` Server-side ToS ack — Day 4.
- ❌ `P3-NEW-C` Reorg posture (accepted risk for beta with marker) — Day 12.
- ❌ `P3-NEW-E` `pnpm audit` + `cargo audit` in CI — Day 5.
- ❌ `P3-NEW-F` Per-wallet rate limit — Day 4.
- ❌ `P3-NEW-H` Docker logging driver options — Day 4.

### 4.4 `octora-web/`

- ✅ `P1-34` Cluster enforced via `VITE_NETWORK`.
- ✅ `P1-35` Network mismatch detection.
- ✅ `P1-36` Beta + UNAUDITED warning UX.
- ❌ `P1-30` Frontend Sentry — Day 2.
- ❌ `P1-37` Error boundaries + skeleton loaders — Day 3.
- ❌ `P1-38` Stealth wallet pre-deposit + export-seed UX — Days 3–4.
- ❌ `P1-39` Mock-data tree-shake CI guard — Day 1.
- ❌ Multi-denomination selector — Days 1–2.
- ❌ Private exit modal + flow — Days 6–9.

### 4.5 Tests

- ❌ `P1-48` `anchor test` in CI + CPI substitution tests + mainnet-cloned fixtures — Days 11–12.
- ✅ `P1-49` Devnet end-to-end (nightly).
- Multi-pool E2E + private exit E2E — Days 5, 10.

### 4.6 Infra

- ✅ `P1-41` Production deploy story (compose + Caddy + Dockerfile).
- ✅ `P1-42` CI/CD.
- ✅ `P1-45` Incident runbooks.

## 5. Failure-mode matrix — what we proactively defend against

| Scenario | Detection | Response | Owner |
| --- | --- | --- | --- |
| Mixer pool drained beyond expected balance | KMS-key balance alarm + custom metrics dashboard | Page operator → operator pages Squads signers → signers sign `set_paused(true)` → root-cause → upgrade or fix | Operator + signers |
| Relayer KMS unavailable | Health check fails → UptimeRobot pages | Failover to standby KMS region (provisioned Day 3) or temporarily switch to file-keypair mode (emergency only, documented in `03_RELAYER_KMS.md`) | Engineer A on-call |
| Stuck position >10 min | Recovery worker Sentry capture | Engineer reviews logs, manually advances or fails the position | Engineer A or B |
| Browser loses stealth wallet (refresh) | User can re-sign authorize message → same stealth derived | Documented in stealth UX modal Day 3 | UX |
| Beta tester reports fund stuck | Tester support channel | Engineer pulls position by ID, walks recovery, manual on-chain action via Squads if needed | Engineer + signers |
| Smart-contract bug discovered | Sentry / tester report / external researcher | Pause via Squads → patch → ceremony if circuit affected → upgrade | All |
| RPC degraded | Health check, `/health` slow → UptimeRobot | Failover to backup RPC URL (configured Day 13) | Operator |
| Database compromise | Audit logs, anomalous query patterns | Snapshot → rotate DATABASE_URL → restore from snapshot if needed | Operator |
| Slot rollback after position advanced | `P3-NEW-C` accepted risk for beta — recovery worker flags any reverted tx | Manual reconciliation; refund from operational wallet if needed | Engineer + operator |

## 6. What ships at end of Week 3

A privacy product where:
- The deposit and the exit edges are both shielded.
- Three denominations cover small / medium / large positions.
- Anonymity-set floor enforced; users see "this pool has N deposits, minimum 20 for withdraw."
- Relayer signing keys live in KMS, segregated, alarmed.
- Both Solana programs upgrade-gated by a Squads multisig.
- Trusted setup ceremony executed by ≥3 independent contributors with public transcripts.
- Verifiable build — anyone can rebuild from the repo + tag and confirm bytecode hash.
- Recovery worker handles partial flows including partial private exits.
- Beta cohort signs a per-user agreement with explicit TVL caps and non-recourse acknowledgement.
- Lawyer-reviewed ToS / Privacy / Risk Disclosure live and ack'd server-side.
- Sentry, UptimeRobot, PagerDuty, custom metrics dashboard, status page all live.

What does NOT ship and why is in §2.
