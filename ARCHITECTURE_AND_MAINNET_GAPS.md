# Octora — current architecture and mainnet gaps

Companion to the architecture flow diagram. Sourced from `runbooks/ARCHITECTURE.md`, `runbooks/PRODUCTION_READINESS.md` (rev 3, 2026-05-10), `README.md`, and the code at the audited commit.

---

## 1. Current architecture

### 1.1 Three trust zones

| Zone | Holds | Trust scope |
| --- | --- | --- |
| User device + wallet | Main wallet seed, stealth seed (in-memory), proof witness, `secret`, `nullifier` | Never reveals private values to anyone |
| `octora-api` host | Position state, beta-access table, auth nonces, mixer-root-seen tracker, relayer hot-wallet keypair | Can refuse user requests, cannot steal funds |
| Solana mainnet | Program bytecode (Squads-multisig upgradeable), pool PDAs, nullifier PDAs, position state | Enforces every constraint the audit threat model relies on |

### 1.2 Components

Browser (`octora-web`, React + Vite + Radix):
- Wallet adapter for Phantom, Backpack, Solflare
- ZK prover in WASM (snarkjs Groth16) — proof generated locally, never leaves the browser
- Stealth wallet derived in-memory from `wallet.signMessage("Octora · Authorize…")`
- Surfaces: pool discovery, pool detail, private-deposit modal, portfolio, position detail, beta + audit-warning UX, network-status guard

Backend (`octora-api`, Fastify + Prisma + Postgres):
- `common/auth.ts` — wallet-signature auth (one-shot Ed25519 nonce)
- `common/health.ts` — real `/health` probe (DB, RPC, relayer, mixer-paused)
- `common/solana-tx.ts` — submit helper with CU profiling, priority fees, blockhash retry
- `modules/positions/` — 11-state lifecycle + repository + recovery worker
- `modules/mixer/` — pool client, deposit cache, on-boot hydrate from chain
- `modules/relayer/` — proof verify, on-chain submit, persistent slot-based privacy delay
- `modules/auth/`, `modules/admin/`, `modules/waitlist/`, `modules/dlmm/`, `modules/prices/`, `modules/executor/`
- Postgres tables: `Position`, `ExecutionSession`, `Activity`, `PositionReconciliation`, `BetaAccess`, `AuthNonce`, `MixerRootSeen`, `Waitlist`

On-chain (`programs/`):
- `octora-mixer` — Groth16 ZK pool with fixed-denomination deposits and withdrawals. PDA seeds `[b"mixer_pool", denomination_le]`. 30-slot Merkle root ring buffer (P1-10 raises to ≥256), 20-level Poseidon tree, nullifier PDAs, `is_paused` flag.
- `octora-executor` — wraps Meteora DLMM (`LBUZ…`) CPI on behalf of stealth wallets. PDA seeds `[b"pool-authority", stealth, pool]`. CPI signer re-pinning, account-substitution checks, `Config.paused` guard on every mutating ix.
- Both ship with `permissionless-init` Cargo feature for devnet, gated by `ADMIN_AUTHORITY` constants in `constants.rs` for mainnet.

### 1.3 Data flow — private deposit

The browser derives `(secret, nullifier)`, computes `commitment = Poseidon(secret, nullifier)`, asks the API to build an unsigned deposit tx, the main wallet signs it, the tx lands on `octora-mixer`. The API never sees `secret` or `nullifier`. The mixer service hydrates the deposit cache from chain on every API boot and on every confirm-deposit call.

### 1.4 Data flow — private withdraw

The browser fetches public deposits, reconstructs the Merkle tree, and generates a Groth16 proof in WASM bound to `(recipient, relayer, fee)` via `paramsBinding = Poseidon(3)` in the circuit (P0-3 fix). It posts to `/relayer/withdraw`. The relayer verifies the proof off-chain, enforces a slot-based persistent privacy delay (`MixerRootSeen`, P0-15 fix), checks the nullifier PDA, and submits the on-chain withdraw. The on-chain verifier re-checks recipient/relayer/fee, so a substituting relayer is rejected.

### 1.5 Data flow — LP execution on Meteora

Position service builds unsigned executor txs (init, claim, withdraw-close), the stealth wallet (in browser memory) signs them, executor program does CPI into Meteora DLMM on behalf of the stealth wallet PDA. Indexer reconciles state from chain into the position state machine.

### 1.6 State machine

11 states, strict transitions:

```
draft → awaiting_signature → funding_in_progress → executing_on_meteora
                                                         ↓
                                                     indexing → active
                                                                ↓
                                              claim ←—————————————————→ withdrawing
                                                                            ↓
                                                                        closing → indexing → completed
Any non-terminal → failed (FailureStage)
```

Recovery worker ticks every 30 s, batch limit 50, advances or fails `executing_on_meteora >5min` and `indexing >2min`. Sentry captures one event per new failure.

---

## 2. What's missing for mainnet production

Source of truth: `runbooks/PRODUCTION_READINESS.md` rev 3 (2026-05-10). 33 items confirmed fixed; 22 still open. Grouped by severity below.

### 2.1 P0 — blockers (must be done before any real-money deposit)

In-code:
- `P0-NEW-A` Delete DAMM modules from `programs/octora-executor/src/instructions/damm/` and rebuild — DAMM is out of scope (DLMM-only) and leaving it compiled in adds attack surface that will not be re-audited. ~2–4 h.
- `P0-NEW-I` Symmetric private exit (`stealth → mixer → relayer → main`). Today the deposit edge is hidden but the close-position edge is on-chain visible, which links `stealth ↔ main` and collapses net privacy to ≈ 0 over a deposit→exit cycle. Extends position state machine with `closing → mixer_exit_pending → relayer_dispatched → finalized`; needs heterogeneous-asset handling for DLMM proceeds (token A + token B + reward tokens). Marketing claim "copy-trade bots see nothing" depends on this. ~3–5 engineer-days.
- `P0-21` Move relayer keypair off the API host — KMS-backed signer (AWS KMS / GCP Cloud HSM via mTLS) or separate signing service on a hardened VM, segregate mixer-fee wallet (≤$500 float) from executor wallet, balance-change alarm, 30-day rotation cadence. ~1–2 days.

Ops (📝, no code change):
- `P0-1` Replace `ADMIN_AUTHORITY` placeholder in `programs/octora-mixer/src/constants.rs` with the real Squads multisig vault PDA before the mainnet build.
- `P0-2` Run the multi-party Groth16 trusted setup ceremony with ≥3 independent contributors per `runbooks/ceremony/PROCEDURE.md`, publish transcripts and entropy attestations, re-derive the on-chain VK from the final `.zkey`, and rebuild. **No mainnet deploy until this is done end-to-end after P0-3 made the circuit final.**
- `P0-6` After mainnet deploy with fresh keypairs, fill `[programs.mainnet]` in `Anchor.toml` and seal the program-id keypairs offline (not in the repo).

### 2.2 P1 — required for invited-cohort beta

In-code, still open:
- `P1-9` Verifiable build via `solana-verify` + reproducible Docker + CI hash check + `runbooks/deployment/verify.md`. ~4 h.
- `P1-10` Raise `ROOT_HISTORY_SIZE` from 30 (~12 s on mainnet) to ≥256 (≈100 s) or 1024 (≈7 min); reassess account size. ~30 min plus redeploy.
- `P1-17` Relayer log retention <24 h, encrypted at rest, log rotation in `infra/docker-compose.prod.yml` (currently unset). ~4 h. Long-term: support user-submitted withdrawals (no relayer) for users who hold gas.
- `P1-18` Anonymity-set minimum (`MIN_ANONYMITY_SET=20`) gate at the mixer service plus UX warning when set is too thin. ~2 h. Apply symmetrically to exits per P0-NEW-I.
- `P1-30` (frontend half) Wire Sentry SDK in `octora-web` with PII redaction (hash wallet addresses before report). ~2 h.
- `P1-37` Top-level + per-page React error boundaries reporting to Sentry, plus skeleton loaders and empty states for `/pools`, `/portfolio`, `/positions/:id`. ~1 day.
- `P1-38` Stealth wallet UX — pre-deposit modal explaining the ephemeral model, export-seed feature, documented recovery flow. ~1 day.
- `P1-39` Mock data tree-shake — audit `import.meta.env.DEV` branches and add a CI guard that the production bundle contains no `MOCK_` / `DEMO_` strings. ~2 h.
- `P1-43` Secrets-management automation (Doppler / 1Password / AWS SM sync) with 30-day rotation reminder. ~4 h.
- `P1-44` Frontend Sentry + UptimeRobot/Better Uptime hitting `/health` every 60 s + custom metrics dashboard (mixer TVL, relayer wallet balance, position state distribution, withdrawal success rate) + PagerDuty/OpsGenie wiring. ~1 day.
- `P1-48` `anchor test` actually executed in CI (currently only `anchor build`), plus explicit CPI-substitution attack tests and mainnet-cloned fixture accounts. ~1–2 days.
- `P1-51` Lawyer-reviewed Terms of Service, Privacy Policy, Risk Disclosure replacing the placeholder text in the signed ToS modal. Covers jurisdiction, dispute resolution, non-custodial framing, no warranty, smart-contract risk, ZK trusted-setup risk, relayer compromise risk, regulatory risk. ~2 weeks lead time.
- `P1-52` Per-user beta cohort agreement letter (acknowledged risk, max deposit cap mirrored server-side, no recourse, confidentiality, bug-reporting channel). ~1 day template + per-user signing.

Ops:
- `P1-7` Transfer upgrade authority for both programs to a Squads v3 multisig (2-of-3 minimum for beta; 3-of-5 before public). ~2 h plus signer coordination.

### 2.3 P2 — required before public launch (after ≥30 days of stable beta)

- `P2-12` `anchor idl init <PROGRAM_ID> --filepath <idl.json>` post-deploy. ~30 min.
- `P2-19` Confirm slippage / `min_out` / `max_active_id` are user-controlled (not hardcoded) on `add_liquidity.rs`, default 0.5 % stable / 1 % volatile, wire UI. ~2 h.
- `P2-32` Managed Postgres (RDS / Supabase / Neon) with PITR, or self-hosted with WAL archiving to S3 every 5 min, daily full backup, weekly tested restore. ~1 day setup plus ongoing ops.
- `P2-33` OFAC / sanctions screening (Chainalysis or TRM Labs at deposit-side) — or documented legal opinion + offshore corporate structure + no US users gating. Tornado Cash precedent makes this the highest-impact regulatory gap. ~1 day integration; weeks for legal opinion.
- `P2-40` Strict CSP (no `unsafe-inline` / `unsafe-eval`; `wasm-unsafe-eval` allowed for snarkjs), SRI hashes on external scripts, dependency audit. ~4 h.
- `P2-46` Procure dedicated mainnet RPC (Helius Premium / Triton / QuickNode) with separate endpoints for relayer (write-heavy, low-latency) and indexer (read-heavy); CDN-cached RPC for frontend. ~2 h once contract signed; 1–2 weeks procurement.
- `P2-50` Load test (Artillery / k6) — 100 concurrent users creating intents, 10/s mixer deposits, verify rate limits and DB pool. ~1 day.
- `P2-53` Bug bounty live on ImmuneFi or Sherlock, tiered $10 k / $50 k / $250 k. ~1 week to draft + list.
- `P2-54` External audit (Zellic / OtterSec / Trail of Bits / Cure53) of programs + circuit + relayer. **Procurement should start now — 6–14 week lead.** Cost $40 k–$120 k.
- `P2-NEW-D` Persist ToS acknowledgement server-side as `(walletAddress, version, signature, acknowledgedAt)` instead of LocalStorage only; required preHandler check on first deposit per wallet per version. ~3 h.

### 2.4 P3 — post-launch hardening (track in backlog)

- `P3-NEW-B` `require_rent_sysvar` should also assert `!is_signer && !is_executable` for defence in depth (currently key-only). ~15 min.
- `P3-NEW-C` Indexer/recovery uses `confirmed` everywhere; switch to `finalized` for state transitions and reverse on detected slot rollback. ~1 day.
- `P3-NEW-E` Add `pnpm audit --prod` + `cargo audit` to CI quarterly job, fail on `high` / `critical`. ~2 h.
- `P3-NEW-F` Per-wallet rate limit layered after `requireWalletSignature` (current limits are IP-keyed, bypassable behind rotating proxies). ~2 h.
- `P3-NEW-G` Frontend Sentry — folded into P1-30/P1-44.
- `P3-NEW-H` `logging.driver: json-file` with `max-size` / `max-file` in `infra/docker-compose.prod.yml`, or ship to managed aggregator with <24 h retention for relayer logs. ~1 h compose change.

---

## 3. Critical-path summary

Roughly **12–17 engineer-days** of remaining code work (revised up to include P0-NEW-I private exit), plus **2–3 weeks** of legal and ops lead-time for the trusted-setup ceremony, the lawyer-reviewed ToS, the dedicated RPC contract, and the Squads multisig setup.

If every code-blocking item closes and every 📝 OPS item executes, Octora is defensible for a small invited cohort with clear caps and warnings. The product is *not* ready for unauthenticated public traffic until the §11 list in `runbooks/PRODUCTION_READINESS.md` is closed (notably P2-33 sanctions screening and P2-54 external audit).
