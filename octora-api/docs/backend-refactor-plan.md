# Octora API — Backend Refactor Plan

Working spec for standardizing, cleaning up, and scaling `octora-api`. Optimized for execution, not presentation. Read top-to-bottom before starting any phase.

---

## Context snapshot

- **Stack:** Fastify 5 · Prisma 7 (pg adapter, PgBouncer-ready) · Postgres 16 · TypeScript strict · Vitest · Pino · pnpm 10 · ES modules · Node 20.
- **Size:** ~13k LOC, 131 files (105 src, 26 test), 15 module domains, 11 route modules.
- **Largest files:** `executor.service.ts` 1009 · `dlmm.service.ts` 896 · `position.service.ts` 728 · `mixer.service.ts` 634 · `relayer.service.ts` 626 · `factories.ts` 354.
- **Background:** one in-process recovery worker (30s tick) — not horizontally scalable.
- **Deploy targets:** Docker (full feature set) and Vercel (read-only routes; worker + relayer disabled).

### What's already good — don't touch
- Module layout (`domain / infra / modules / common`); repository pattern keeps Prisma out of services.
- Strict TS; no `any` in service layer (5 unavoidable in dynamic Sentry import).
- Pino JSON logging with redaction of signatures/nonces/auth headers, request-ID propagation.
- Real `/health` (probes deps) and `/metrics` (JSON snapshot).
- Wallet-signature auth: nonce-based, single-use, 5-min TTL, ed25519 via Node crypto.
- In-memory test repos + factories (fast vitest, no DB needed).

### What hurts now or will hurt soon

| Area | Symptom | Where | Sev |
|---|---|---|---|
| Error handling | Custom classes mixed with generic `Error`; controllers string-match messages to set status. | `relayer/*`, `deposit.service.ts` | P0 |
| Beta-cap aggregation | `findMany` + JS reduce; O(n) memory per call. | `position.repository.ts:64` (`sumActiveAmountSol`) | P0 |
| Rate limiter | In-memory, IP-keyed only. Doesn't survive multi-instance or coordinated abuse. | `mixer/rate-limit.ts` | P0 |
| Validation | Fastify JSONSchema only; BigInt/PublicKey parsing manual in handlers, throws uncaught. | all controllers | P1 |
| Config drift | `process.env.MIXER_MIN_ANONYMITY_SET` read directly, bypassing central config. | `mixer.service.ts:41` | P1 |
| Mega-services | 1009/896/728 LOC files mix concerns. | `executor`, `dlmm`, `positions` | P1 |
| Test code in prod | `testWalletStamper()` + `options.prisma === undefined` branch. | `position.routes.ts:31–53` | P1 |
| External resilience | No circuit breaker / backoff for Meteora & Jupiter. | `dlmm.service.ts`, `prices` | P2 |
| Hardcoded constants | `DLMM_PROGRAM_ID`, `PRESET_PARAMETER` baked in; not env-configurable. | `executor.service.ts:55–62` | P2 |
| Missing indexes | `PositionReconciliation` PK-only; `ExecutionSession.failureStage` filtered but unindexed. | `prisma/schema.prisma` | P2 |
| Type sharing | Response shapes only in Fastify schemas; FE re-declares — drift risk. | all routes | P2 |
| Audit comments | `P0-20`, `P1-30` references throughout; external doc will rot. | cross-cutting | P3 |

Severity legend: **P0** blocks scale/correctness · **P1** high payoff/low risk · **P2** structural cleanup · **P3** nice-to-have.

---

## Refactor principles

1. **One way to do each thing.** One error base. One validator. One config module. One response envelope. Inconsistency *is* the bug.
2. **Boundaries enforce themselves.** If `process.env` is only readable in `common/config/`, drift can't happen. If Prisma only imports in `*.repository.ts`, services stay pure. Use eslint `no-restricted-syntax` / `no-restricted-imports`.
3. **Decompose by axis of change.** Split files by *what changes together*, not by line count.
4. **SQL beats JS.** Aggregations, counts, sums go to Postgres. Don't loop over rows you could `SUM()`.
5. **Stateless processes.** Anything in a `Map` (rate limits, caches, anonymity-set state) needs a multi-instance story — even if today's answer is "single instance, Redis at X RPS".
6. **No new feature work in this refactor.** Behavior changes are out of scope. Diffs reviewable as pure structure.

---

## Target file tree

```
src/
├── app.ts                          # composition root only — no logic
├── index.ts                        # boot
├── common/
│   ├── config/
│   │   ├── index.ts                # loadConfig() — only file reading process.env
│   │   ├── schema.ts               # zod schema for AppConfig             [new]
│   │   └── parsers.ts              # parseCsv, parseBigIntList, …         [new]
│   ├── errors/                                                            [new]
│   │   ├── ApiError.ts             # base + statusCode + code
│   │   ├── domain-errors.ts        # NotFound, Conflict, Validation, …
│   │   └── error-handler.ts        # Fastify setErrorHandler
│   ├── http/
│   │   ├── envelope.ts             # { data } / { error } shape           [new]
│   │   ├── validation.ts           # zod → Fastify schema bridge          [new]
│   │   └── plugin.ts               # cors, swagger, request-id
│   ├── observability/
│   │   ├── logger.ts               # pino + redaction
│   │   ├── sentry.ts
│   │   └── metrics.ts
│   ├── auth/                       # wallet-signature, beta access, admin token
│   ├── db/
│   │   ├── client.ts               # PrismaClient singleton
│   │   └── tx.ts                   # withTransaction helper               [new]
│   ├── ratelimit/                  # interface + memory + redis impls     [new]
│   └── solana/                     # connection, keypair loaders
├── domain/                         # pure business logic, no IO
├── modules/
│   └── <name>/
│       ├── <name>.routes.ts        # Fastify wiring, schema → service
│       ├── <name>.controller.ts    # thin: parse → service → envelope
│       ├── <name>.service.ts       # business logic
│       ├── <name>.repository.ts    # Prisma only
│       ├── <name>.schemas.ts       # zod input/output schemas
│       ├── <name>.types.ts         # exported domain types
│       └── __tests__/
├── modules/executor/
│   └── builders/                   # split from 1009-LOC service          [new]
│       ├── dlmm-pool.builder.ts
│       ├── token.factory.ts
│       └── liquidity.planner.ts
├── workers/                        # extracted from modules/positions     [new]
│   └── recovery.worker.ts
└── test-kit/
    ├── factories/                  # split from 354-LOC monolith
    └── memory-repos/
```

---

## Phase 0 — Foundation (~3 days)

Land the primitives every later phase depends on.

- **[P0] `ApiError` base class.** Properties: `statusCode: number`, `code: string`, `details?: unknown`. Subclasses: `NotFoundError`, `ConflictError`, `ValidationError`, `UnauthorizedError`, `RateLimitedError`, `UpstreamError`. Global `setErrorHandler` formats response from `err instanceof ApiError`; falls through to 500 + log for unknown.
- **[P0] Migrate existing custom errors** (`PositionNotFoundError`, `AnonymitySetTooThinError`, `JupiterPriceError`, `MeteoraApiError`) to extend `ApiError`. Backwards-compatible — same names, parent changes. Controller status-code branches collapse.
- **[P1] Adopt `zod` for request validation.** Bridge to Fastify via `zodToJsonSchema` so OpenAPI/Scalar still works. Failed parses become `ValidationError`. BigInt strings, base58 pubkeys, denomination enums get a single source of truth.
- **[P1] Reimplement `config.ts` as a zod schema + `parsers.ts` helpers** (`parseCsv`, `parseBigIntList`, `parseBoolean`, `parseUrlList`). Replaces the 83-LOC ad-hoc parsing block (`loadMixerDenominations / loadFrontendUrl / loadMixerRelayerConfig`).
- **[P1] Lint rule banning `process.env` outside `common/config/`** (eslint `no-restricted-syntax` on `MemberExpression[object.object.name="process"][object.property.name="env"]`). Mechanically catches the `mixer.service.ts:41` drift.
- **[P2] Standard response envelope:** `{ data: T }` on success, `{ error: { code, message, details? } }` on failure. Codify in `http/envelope.ts`. Ship behind per-route opt-in flag; flip routes one at a time after FE updates.

**Done when:** controllers contain zero `if (err.message.includes(...))`; one validator drives both runtime and OpenAPI; `grep process.env src/` returns only `common/config/`.

---

## Phase 1 — Module standardization (~4 days)

Every `modules/<name>/` follows the same template. Touching a new module needs zero orientation.

- **[P1] Adopt the canonical 6-file template** (routes, controller, service, repository, schemas, types). Refactor each module; collapse stragglers into `__internal/`. Today some modules have `controller.ts`, others stuff handlers in `routes.ts`.
- **[P1] Move every Prisma call into `*.repository.ts`.** Lint-ban `@prisma/client` imports outside repositories & `common/db/`. Already ~90% there.
- **[P1] Extract `testWalletStamper()` and the `options.prisma === undefined` branch** out of `position.routes.ts:31–53` into `test-kit/route-harness.ts`. Tests build their own app. Production code shouldn't conditionally execute on missing dependencies.
- **[P2] Generate shared types package (`octora-api-types`)** from zod schemas. Frontend imports it instead of redeclaring; drift becomes a type error, not a runtime surprise.
- **[P3] Replace `console.*` with `app.log.*`** across 19 sites. Remove `P0-20 / P1-30` audit-ticket comments — link to internal tracker once in `SECURITY.md`.

**Done when:** every module has the same six files; lint forbids cross-boundary imports; no test branches in production routes.

---

## Phase 2 — Decompose the mega-services (~5 days)

Split along natural seams. Files become greppable; concerns become testable in isolation.

- **[P1] Split `executor.service.ts` (1009 LOC)** into:
  - `builders/dlmm-pool.builder.ts` — pool setup
  - `builders/token.factory.ts` — token mint creation
  - `builders/liquidity.planner.ts` — bin math + placement
  - `executor.service.ts` (~150 LOC) — orchestration only
  Each builder testable with mocked Anchor program.
- **[P1] Split `dlmm.service.ts` (896 LOC)** into:
  - `dlmm.api.ts` — Meteora HTTP client (+ circuit breaker, see Phase 3)
  - `dlmm.chain.ts` — chain-direct fallback (localnet)
  - `dlmm.service.ts` — resolution policy (which source to use)
  Adding a third source becomes trivial.
- **[P1] Split `position.service.ts` (728 LOC)** by lifecycle stage:
  - `position.intent.service.ts`
  - `position.execution.service.ts`
  - `position.claim.service.ts`
  State-machine guard stays in `domain/`. Mirrors the state graph that already exists.
- **[P2] Move `recovery-worker.ts` to top-level `workers/`.** Workers depend on services, not the other way around. Today it's buried in the module that defines its target — circular when worker grows.
- **[P2] Split `test-kit/factories.ts` (354 LOC)** per domain: `position.factory.ts`, `activity.factory.ts`, `walkthrough.factory.ts`.
- **[P2] Pull DLMM `PROGRAM_ID` and `PRESET_PARAMETER` into config** (`OCTORA_DLMM_PROGRAM_ID`, `OCTORA_DLMM_PRESET_PARAMETER`) with mainnet defaults. Localnet/devnet/mainnet need different IDs.

**Migration discipline:** ship each split as two PRs — (1) mechanical move, public exports unchanged; (2) caller simplification. Phase-1 PR is reviewable as "no logic changes, no diff in tests".

**Done when:** no file in `modules/` exceeds 500 LOC; no hardcoded program IDs outside config.

---

## Phase 3 — Scalability: drop the in-memory shortcuts (~5 days)

Anything blocking >1 instance comes out. Postgres or Redis takes over.

- **[P0] Replace `sumActiveAmountSol()` JS reduce** with `prisma.position.aggregate({ _sum: { amount: true }, where: { state: { in: ['intent','executing','active'] } } })`. Add partial index for that state set.
- **[P0] `RateLimiter` interface** with two implementations:
  - `MemoryRateLimiter` — current behavior, dev default
  - `RedisRateLimiter` — token-bucket via Redis Lua `SCRIPT`
  Selection from config (`RATE_LIMITER=memory|redis`). Same API, swap at boot.
- **[P0] Wallet-keyed rate limits** when a wallet is present in the request: composite key `{wallet}:{route}`, fall back to `{ip}:{route}` for unauthenticated routes.
- **[P1] Generic `CircuitBreaker` wrapper** for outbound HTTP. N failures within window → open; half-open probe; close on success. Wrap Meteora and Jupiter clients.
- **[P1] Per-pool TTL cache** for Meteora fetches (`lru-cache` keyed by pool address). Configurable TTL, formalize the existing 5s implicit cache.
- **[P2] Missing indexes** (all via `CREATE INDEX CONCURRENTLY` raw SQL, not Prisma-generated):
  - `PositionReconciliation(positionId)`
  - `ExecutionSession(state, failureStage)`
  - `Position(state, createdAt)` — recovery-worker scan path
- **[P2] Connection pool tuning.** Explicit Prisma datasource pool size; document PgBouncer mode (transaction vs session); add `statement_timeout` guard.

**Done when:** beta-cap check is one SQL query; rate limiter has Redis impl and is wallet-keyed; outbound HTTP wrapped in breaker; recovery-worker scans use indexes.

---

## Phase 4 — Observability & testing (~4 days)

Catch regressions from this refactor and make the next one cheaper.

- **[P1] Per-route latency histograms** in `/metrics`: `http_request_duration_ms{route, status}`. Today's metrics are point-in-time totals; can't spot a degrading route.
- **[P1] Integration test layer.** `beforeAll` spins up Postgres + Fastify; tests hit real routes with real auth. One test per route: happy path + 401/403/422.
- **[P2] Recovery-worker deterministic test.** Fake RPC sequence of `getSignatureStatuses` responses; verify exact-once Sentry capture and idempotent state advance.
- **[P2] Document Sentry activation in README** (currently a dynamic import nobody enables).
- **[P2] OpenTelemetry traces** (Fastify plugin). Span propagation through services → repos → outbound HTTP. "Which downstream call was slow?" becomes a trace lookup.

**Done when:** `/metrics` exposes per-route histograms; every route has happy + auth-fail integration test; recovery worker has a fake-RPC test.

---

## Phase 5 — Long-term: queues & horizontal scale (defer)

Plan now so the move is mechanical when traffic justifies it.

- **[P3] Move recovery worker to BullMQ** (Redis jobs). Each stuck position = delayed job; retries / DLQ free. Removes "single-instance only" footnote; Vercel-deployable.
- **[P3] Materialize beta-cap aggregates** as a Postgres view or trigger-maintained `position_caps` counter. Even with `SUM()`, sub-ms reads matter for a hot pre-write check.
- **[P3] Read replica** for analytics queries (`/metrics`, admin endpoints).

---

## Risk register

| Risk | Mitigation |
|---|---|
| Error envelope change breaks frontend | Phase 0 envelope behind per-route opt-in flag; flip routes one at a time after FE updates. |
| zod migration drops a validation case | Run both validators in parallel for one release; log when zod accepts but JSONSchema would have rejected (and vice versa). |
| Repository split surfaces a hidden Prisma call | Lint rule lands in Phase 0 — failures appear at PR time, not in production. |
| Redis dependency for rate limiter blocks dev | `MemoryRateLimiter` stays the dev default; Redis only required when `RATE_LIMITER=redis`. |
| Index migrations lock `Position` table | `CREATE INDEX CONCURRENTLY` via raw SQL migrations (Prisma-generated migrations don't support it). |

---

## Definition of done

**Standardization**
- One error base class; controllers contain zero `if (err.message.includes(...))`.
- One validator (zod). Same schemas drive OpenAPI and runtime.
- One config module; `process.env` grep returns only `common/config/`.
- Every module follows the 6-file template.

**Cleanliness**
- No file over 500 LOC in `modules/`.
- No test branches in production routes.
- No `console.*` in `src/`.
- Zero hardcoded program IDs / magic constants outside config.

**Scalability**
- Beta-cap check is a single SQL aggregate.
- Rate limiter has a Redis impl; wallet-keyed when wallet present.
- All outbound HTTP wrapped in circuit breaker.
- Every recovery-worker scan path covered by an index.

**Observability**
- Per-route latency histograms exposed.
- Integration tests cover every route's happy + auth-fail path.
- Recovery worker has a deterministic test against a fake RPC.

---

## Sequencing

Phases are mostly parallelizable after Phase 0. Solo-dev order:

**0 → 1 → 3 (P0 only) → 2 → 3 (rest) → 4 → 5**

The P0 items in Phase 3 (aggregation, rate limiter) jump the queue because they're surgical fixes that don't depend on the module decomposition.

---

## Open decisions before coding

1. **Response envelope** — `{ data }` / `{ error }` standardization changes the FE contract. Worth it, or only standardize errors and leave success shapes alone?
2. **zod adoption** — adds a runtime dep but pays for itself in BigInt/PublicKey parsing and FE type sharing. Confirm yes/no.
3. **Sequencing** — happy with `0 → 1 → 3-P0 → 2 → 3-rest → 4`, or do mega-service split (Phase 2) first because it dominates everyone's diffs?
