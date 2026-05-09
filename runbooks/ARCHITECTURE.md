# Octora — Architecture (P1-55)

**Status:** Authoritative description of how the components fit together at the audited commit.
**Last updated:** 2026-05-10.
**Audience:** New engineers, auditors, integration partners.

A privacy product is only as trustworthy as its architecture is legible. This doc maps every component, its trust scope, and the data that flows between them. Read alongside `runbooks/PRIVACY_MODEL.md` (what each boundary protects).

## 1. Components

```
┌──────────────────────────────────────────────────────────────────────┐
│                              Solana mainnet                          │
│                                                                      │
│   ┌────────────────┐         ┌─────────────────────┐                 │
│   │ octora-mixer   │         │ octora-executor     │                 │
│   │ Groth16 mixer  │  CPI ── │ DLMM/DAMM CPI       │ ── CPI ──▶ Meteora
│   │ + Merkle pool  │         │ wrapper + Config    │            DLMM/DAMM
│   └────────────────┘         └─────────────────────┘                 │
│         ▲                              ▲                             │
└─────────┼──────────────────────────────┼─────────────────────────────┘
          │                              │
          │ deposit / withdraw txs       │ initPosition / addLiquidity / claim / withdraw
          │                              │
┌─────────┴──────────┐           ┌───────┴────────┐
│ octora-web (SPA)   │ ── HTTPS ▶│ octora-api     │
│ React/Vite         │           │ Fastify        │
│ ZK proving in-     │           │ + Prisma + PG  │
│ browser (WASM)     │           └────────────────┘
└────────────────────┘                 │ │
        ▲                              │ │
        │ signMessage / signTransaction│ │
        │                              │ ▼
┌───────┴────────┐         ┌──────────────┐
│ wallet         │         │ relayer hot  │
│ (Phantom etc.) │         │ wallet (Solana)│
└────────────────┘         └──────────────┘
```

### Smart contracts (`programs/`)

| Program | Purpose | Authority | Pause |
| --- | --- | --- | --- |
| `octora-mixer` | Groth16 ZK pool with fixed-denomination deposits + withdrawals. PDA seeds: `[b"mixer_pool", denomination_le]`. Storage: 30-slot Merkle root ring buffer (audit P1-10 will move to 256), 20-level Poseidon tree, nullifier PDAs. | `MixerPool.authority` (Squads vault PDA after `MAINNET.md` step 8). | `MixerPool.is_paused` flag flipped by `set_paused`. |
| `octora-executor` | Wraps Meteora DLMM (`LBUZ...`) and DAMM (`Eo7W...`) CPI calls on behalf of stealth wallets. PDA seeds: `[b"pool-authority", stealth, pool]`. Adds CPI-signer re-pinning (audit Fix #4) and account-substitution checks. | `Config.authority` (Squads vault PDA). | `Config.paused` checked on every state-mutating ix. |

Both programs ship with a `permissionless-init` Cargo feature for devnet/local testing; mainnet builds default to the gated `ADMIN_AUTHORITY` constants in `constants.rs`.

### Backend (`octora-api/`)

Fastify + Prisma + Postgres. Modules:

| Module | What it does |
| --- | --- |
| `common/auth.ts` | Wallet-signature auth (one-shot nonce + Ed25519 verify via `node:crypto`). |
| `common/health.ts` | Real `/health` probe — DB / RPC / relayer / mixer-paused. |
| `common/metrics.ts` | `/metrics` JSON snapshot (mixer pool state + position distribution). |
| `common/observability.ts` | Pino JSON + ISO timestamps + `redact` rules + Sentry seam. |
| `common/solana-tx.ts` | Retry-aware submit helper (CU profiling, priority fees, blockhash retry). |
| `modules/positions/` | Position lifecycle state machine + repository + recovery worker. |
| `modules/mixer/` | Mixer pool client, deposit cache, hydrate-from-chain on boot. |
| `modules/relayer/` | Withdraw proof verification, on-chain submission, persistent root-seen privacy delay. |
| `modules/auth/` | `POST /auth/nonce`. |
| `modules/admin/` | `POST /admin/waitlist/{approve,revoke}` (bearer-gated). |
| `modules/waitlist/` | Email signups + per-wallet `BetaAccess` table. |
| `modules/dlmm/` | DLMM pool data passthrough to Meteora indexers. |
| `modules/prices/` | Jupiter price proxy. |
| `modules/executor/` | Builds unsigned executor txs (init, claim, withdraw-close) for the browser. |

State lives in Postgres via Prisma:

| Table | Purpose |
| --- | --- |
| `Position`, `ExecutionSession`, `Activity` | Position lifecycle. |
| `PositionReconciliation` | Indexer's stamped venue signature. |
| `BetaAccess` | Approved wallets. |
| `AuthNonce` | One-shot signed-nonce challenges. |
| `MixerRootSeen` | Persistent privacy-delay tracker (P0-15). |
| `Waitlist` | Email signups. |

### Frontend (`octora-web/`)

React + Vite + Radix UI. Major surfaces:

| Surface | Files |
| --- | --- |
| Pool discovery | `pages/PoolsPage.tsx`, `components/octora/lp/`. |
| Pool detail + private deposit | `pages/PoolDetailPage.tsx`, `components/octora/lp/PrivateDepositModal.tsx`. |
| Portfolio + position detail | `pages/PortfolioPage.tsx`, `pages/PositionDetailPage.tsx`. |
| Beta + audit-warning UX | `components/octora/BetaWarningBanner.tsx`, `components/octora/lp/TosAckModal.tsx`, `components/octora/lp/StealthExplainerModal.tsx`. |
| Solana client | `lib/solana/{config,client}.ts`, `providers/SolanaProvider.tsx`. |
| ZK prover | `lib/mixer/`, `lib/privateDeposit.ts`, `lib/privateLifecycle.ts`. |
| Stealth wallet | `lib/stealthVault.ts`. |
| Network status | `lib/networkStatus.ts`. |

The build is cluster-aware via `VITE_NETWORK`; production builds throw at module-load if it's unset (P1-34).

### Operational tooling

| Tool | Where |
| --- | --- |
| Dockerfile + docker-compose.prod | `octora-api/Dockerfile`, `infra/docker-compose.prod.yml`, `infra/Caddyfile`. |
| CI | `.github/workflows/ci.yml`. |
| Deploy | `.github/workflows/deploy.yml`. |
| Nightly e2e | `.github/workflows/nightly-e2e.yml`. |
| Recovery worker | `octora-api/src/modules/positions/recovery-worker.ts`. |

## 2. Data flow — private deposit

```
┌──────────────────┐
│ User clicks      │
│ "Deposit"        │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────────┐
│ Stealth explainer modal (first time)     │
│ ToS ack modal (first time, signed)       │
└────────┬─────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────┐
│ Browser derives stealth keypair via      │
│ wallet.signMessage("Octora · Authorize…")│
└────────┬─────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────┐
│ Browser computes secret + nullifier,     │
│ commitment = Poseidon(secret, nullifier) │
└────────┬─────────────────────────────────┘
         │
         ▼  POST /mixer/deposit-tx
┌──────────────────────────────────────────┐
│ API builds unsigned deposit tx; main     │
│ wallet signs and submits.                │
└────────┬─────────────────────────────────┘
         │
         ▼  on-chain DepositEvent emitted
┌──────────────────────────────────────────┐
│ Indexer hydrates the deposit cache from  │
│ chain on every API boot + on each        │
│ confirm-deposit call.                    │
└──────────────────────────────────────────┘
```

The API never sees `secret` or `nullifier` — they live in the browser's session memory only.

## 3. Data flow — private withdraw

```
Browser                         API/Relayer                   On-chain
───────                         ───────────                   ────────
                                                              ┌────────────┐
┌──────────────┐                                              │ Mixer pool │
│ User wants to│ GET /mixer/deposits                          │ Merkle root│
│ withdraw     │ ───────────────────────────────▶ ──────────▶ │ ring buffer│
└──────┬───────┘                                              └────────────┘
       │
       ▼
┌──────────────────┐
│ Reconstruct      │
│ Merkle tree from │
│ public deposits  │
└──────┬───────────┘
       │
       ▼  Generate Groth16 proof in WASM
┌──────────────────┐
│ proof, public    │
│ inputs           │
└──────┬───────────┘
       │ POST /relayer/withdraw
       ▼
                                ┌─────────────────────┐
                                │ Relayer verifies    │
                                │ proof off-chain;    │
                                │ checks privacy      │
                                │ delay (slot-based,  │
                                │ persistent);        │
                                │ checks nullifier    │
                                │ via on-chain PDA    │
                                └────────┬────────────┘
                                         │ submitConfirmed
                                         │  (CU profiling, priority fees,
                                         │   blockhash retry)
                                         ▼
                                                         ┌─────────────────┐
                                                         │ withdraw ix     │
                                                         │ creates         │
                                                         │ NullifierPDA    │
                                                         │ + transfers     │
                                                         │ denomination -  │
                                                         │ fee → recipient │
                                                         └─────────────────┘
```

The recipient address is bound to the proof's public inputs (Groth16 binding) AND non-linearly into the witness via the Poseidon `paramsBinding` (P0-3). Any relayer that tries to substitute the recipient gets rejected by the on-chain verifier.

## 4. Trust boundaries

```
┌────────────────────────────── trust boundary 1 ──────────────────────────────┐
│ User device + wallet                                                        │
│  ↳ holds: main-wallet seed, stealth seed (in-memory), proof witness         │
│  ↳ never reveals private values to anyone                                   │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ (Ed25519 signed messages, public proofs)
                                    ▼
┌────────────────────────────── trust boundary 2 ──────────────────────────────┐
│ octora-api host                                                              │
│  ↳ holds: position state, beta-access, auth-nonce table, mixer-root-seen    │
│  ↳ holds: relayer hot-wallet keypair (KMS-backed in mainnet)                │
│  ↳ trust scope: can refuse user requests; CANNOT steal funds                │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ (Solana RPC over TLS, signed txs)
                                    ▼
┌────────────────────────────── trust boundary 3 ──────────────────────────────┐
│ Solana mainnet                                                               │
│  ↳ holds: program bytecode (Squads-multisig upgradeable), pool PDAs,        │
│           nullifier PDAs, position state                                    │
│  ↳ trust scope: enforces every constraint the audit's threat model relies on│
└──────────────────────────────────────────────────────────────────────────────┘
```

For each boundary, the protections that hold even if the next layer is compromised:

| Compromise scenario | Mitigation that still works |
| --- | --- |
| User's browser is compromised by malware after a deposit | Funds are in the mixer; an attacker without the user's wallet cannot withdraw to themselves (proof binds recipient). They can withdraw to the user's own exit wallet, which doesn't help them. |
| `octora-api` host is compromised | Cannot mint counterfeit proofs (trusted setup); cannot drain mixer (proof binds recipient); CAN deny service and CAN compromise privacy (relayer logs). |
| `octora-mixer` upgrade authority key compromised | The fix is the multisig — see `runbooks/deployment/upgrade-authority.md`. Without ≥ 2 signers, an upgrade cannot land. |
| RPC provider compromised | Cannot inject txs (the user's wallet signs); CAN delay or rewrite block visibility short of finalization. Mitigation: `recovery-worker` retries via signature-status, `/health` flips on RPC failure. |

## 5. State machine — position lifecycle

The position state machine lives in `octora-api/src/domain/state-machine.ts` and is the contract every UI / recovery / indexer relies on:

```
draft ──▶ awaiting_signature ──▶ funding_in_progress ──▶ executing_on_meteora
                                                              │
                                                              ▼
                                                          indexing
                                                              │
                                                              ▼
                                                           active
                                                            │   │
                                       claim ◀──────────────┘   └──────▶ withdrawing
                                                                              │
                                                                              ▼
                                                                          closing ──▶ indexing ──▶ completed

Any non-terminal state ─▶ failed (with FailureStage)
```

Recovery worker watches `executing_on_meteora` (>5min) and `indexing` (>2min) and advances or fails them. Failed positions emit a single Sentry capture per new failure (P1-29).

## 6. Build / deploy graph

```
git tag mainnet-deploy-YYYY-MM-DD
        │
        ▼
.github/workflows/ci.yml ──▶  green checks required for merge
        │
        ▼
.github/workflows/deploy.yml
        │
        ├──▶ build & push: ghcr.io/<owner>/octora-api:<sha>
        │
        ├──▶ deploy → staging  (auto on main merge)
        │
        └──▶ deploy → production
                │
                └──▶ requires `production` GitHub environment approval
                        │
                        └──▶ rolling restart of compose services on the
                             single VM, healthcheck-gated
```

Smart contracts are NOT in this CI/CD path — they ship via the manual `runbooks/deployment/MAINNET.md` procedure, with the same Squads-co-signed flow as upgrade-authority changes.

## 7. Where to start reading

For each role, the right entry points:

- **Backend engineer:** `octora-api/src/app.ts` → `modules/positions/position.routes.ts` → `modules/positions/position.service.ts`.
- **Frontend engineer:** `octora-web/src/App.tsx` → `components/octora/AppShell.tsx` → `pages/PoolDetailPage.tsx`.
- **Smart-contract reviewer:** `programs/octora-mixer/src/lib.rs` → `instructions/withdraw.rs` → `verifier/groth16.rs`. Then `programs/octora-executor/src/lib.rs` → `instructions/admin.rs`.
- **Operator on-call:** `runbooks/incident/` (start with `mixer-pause.md`).
- **New beta user:** read `runbooks/PRIVACY_MODEL.md` first.

Every component has a corresponding section above; the cross-references are the contract.
