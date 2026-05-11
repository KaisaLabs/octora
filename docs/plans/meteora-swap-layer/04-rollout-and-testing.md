# Plan 4 — Rollout, testing, audit prep

**Layer:** Devnet shakedown · feature flag · documentation · audit pack
**Effort:** 2–3 engineer-days + 1 week devnet observation
**Depends on:** Plans 1–3 complete
**Blocks:** Mainnet flip

## Goal

Stage the swap layer to mainnet without putting users at risk. Devnet shakedown for ≥7 nights green, feature flag for staged enable, audit-ready diff for the new CPI surface.

## Phases

```
[Phase A] Localnet smoke
   ↓
[Phase B] Devnet deploy + nightly e2e (≥7 nights)
   ↓
[Phase C] Audit pack drafted + reviewed
   ↓
[Phase D] Mainnet deploy with feature flag OFF
   ↓
[Phase E] Allowlist beta wallets — flag ON for them only
   ↓
[Phase F] Default ON for all beta wallets
```

Each phase has explicit gates listed below. Do not skip.

## Phase A — Localnet smoke (½ day)

- Surfpool fixture seeded with: SOL/USDC pool (deep), MEMECOIN/SOL pool (target), MEMECOIN/USDC pool (alt source).
- Run `tests/octora-executor-dlmm-swap.ts` + `tests/octora-e2e-full-lifecycle.ts` (extended to cover swap step).
- Manual smoke: surfpool RPC + local API + local frontend; create a position into MEMECOIN/SOL with swap source SOL/USDC, observe full lifecycle.

**Gate:** All tests green; manual smoke produces an `active` position.

## Phase B — Devnet shakedown (1 week observation)

### Deploy
- Deploy executor with swap ix to devnet program ID.
- Update `Anchor.toml` `[programs.devnet]` if needed.
- Migrate API DB on the devnet env; flip `EXECUTOR_SWAP_ENABLED=true` for devnet only.
- Frontend devnet build picks up new components.

### Nightly e2e
Extend the existing nightly smoke (per Day 6 commit `a9045e9`) to:

1. Create position on a non-SOL devnet pair.
2. Assert state machine transitions through `swap_*` states.
3. Verify on-chain swap tx and LP tx are distinct.
4. Verify final position is `active` with non-zero liquidity.
5. Close position; verify exit swap path (per P0-NEW-I when shipped — Phase B-2 if exit lands later).

### Observability
- Sentry alerts on any new failure mode (`swap_failed` stage).
- Custom metric: `swap_success_rate` per night. Target ≥99% for 7 consecutive nights.
- Track `swap_slippage_realized` distribution; alert if p95 > configured cap.

**Gate:** 7 consecutive nights with ≥99% swap success rate. Zero unexplained `swap_failed`.

## Phase C — Audit pack (1 day)

Draft `docs/plans/meteora-swap-layer/audit-pack.md` listing:

- All program file changes with diff summary.
- New CPI surface: account list, signer constraints, slippage check, pause gate.
- New backend states + transitions.
- Negative test coverage matrix (what each test asserts, what attack it defends against).
- Suggested fuzz inputs: amount_in, min_amount_out, swap direction, malformed bin arrays.
- Cross-reference to `runbooks/PRODUCTION_READINESS.md` items affected (P0-NEW-A, P0-NEW-I, P1-48, P2-19).

If external audit (P2-54) is in progress, hand the pack to the auditor as a focused diff. If not, internal review by ≥2 engineers focused on:

- CPI re-pinning correctness
- Balance-delta slippage check
- State machine transition guards
- Same-pool reject (both client and server)

**Gate:** Pack reviewed; all "must fix before mainnet" comments addressed.

## Phase D — Mainnet deploy, flag OFF (½ day)

- Deploy executor binary to mainnet (per existing `runbooks/deployment/MAINNET.md`).
- API mainnet env: `EXECUTOR_SWAP_ENABLED=false`. Pool browser hides non-SOL pairs.
- Smoke: confirm existing SOL-only flow still works untouched. No swap path exposed.

**Gate:** Existing flow unaffected. No swap-related code paths reachable from mainnet UI/API.

## Phase E — Allowlist enable (1 week observation)

- Add `BetaAccess.swapEnabled: bool` flag (Prisma migration).
- API checks `betaAccess.swapEnabled` in addition to `EXECUTOR_SWAP_ENABLED`. When `true` for the user's wallet, the swap path is exposed.
- Pick 3–5 sophisticated beta users; enable for them.
- Monitor for 1 week:
  - Swap success rate
  - Realized slippage vs predicted
  - Position lifecycle completion rate
  - Sentry exceptions
  - Mixer pool TVL impact

**Gate:** Zero P0/P1 incidents; user feedback positive; metrics within targets.

## Phase F — Default on (½ day)

- Set `BetaAccess.swapEnabled` default `true` for all approved wallets.
- Update marketing/landing copy to reflect "any Meteora pair" support.
- Bump `CURRENT_TOS_VERSION` in case of any policy change.

**Gate:** Continuous monitoring for 30 days; first month of broad use stable.

## Documentation deliverables (parallel with Phase C)

| File | Update |
| --- | --- |
| `runbooks/PRODUCTION_READINESS.md` | Mark P0-NEW-A as prerequisite; add audit entry for swap CPI |
| `runbooks/PRIVACY_MODEL.md` | Acknowledge stealth-side swap is observable; clarify privacy boundary is `main ↔ stealth`, not action content |
| `runbooks/ARCHITECTURE.md` | Update diagram to include swap layer |
| `runbooks/incident/swap-failure.md` (NEW) | Triage: bad price, dropped tx, paused executor, pool drained |
| `runbooks/deployment/MAINNET.md` | Note new env var `EXECUTOR_SWAP_ENABLED` |
| `README.md` | Update "Execution modes" table — add swap step note |

## CI changes

- Add `tests/octora-executor-dlmm-swap*.ts` to anchor test suite (Plan 4 also wires `anchor test` into CI per P1-48).
- Add Playwright `lp-with-swap.spec.ts` to nightly e2e GitHub Action.
- Lint check: grep for `damm` in source — fail if any references remain (covers P0-NEW-A regression).

## Feature flag matrix

| Env | `EXECUTOR_SWAP_ENABLED` | `BetaAccess.swapEnabled` | Result |
| --- | ----------------------- | ------------------------ | ------ |
| Localnet | true | n/a | All pairs |
| Devnet | true | true (default) | All pairs |
| Mainnet (Phase D) | false | n/a | SOL-only (hidden) |
| Mainnet (Phase E) | true | per-wallet | Swap allowed for allowlisted wallets |
| Mainnet (Phase F) | true | true (default) | All approved wallets |

## Acceptance (overall)

- [ ] Phase A: localnet smoke green.
- [ ] Phase B: 7 nights green on devnet; metrics in target.
- [ ] Phase C: audit pack reviewed; all blocking comments addressed.
- [ ] Phase D: mainnet deployed; existing SOL flow untouched.
- [ ] Phase E: allowlisted users execute ≥10 swap-LP positions without P0/P1 incident.
- [ ] Phase F: default on; 30 days continuous stability.

## Risks

| Risk | Mitigation |
| --- | --- |
| Devnet DLMM behavior differs from mainnet | Compare devnet vs mainnet IDL hashes; flag any drift |
| Allowlist users hit edge cases not seen in synthetic tests | Phase E length is flexible — extend to 2 weeks if needed |
| Pause-mid-flight: user has swap done but LP not yet | Recovery worker handles; ensure stealth wallet's intermediate token balance can be recovered without swap re-execution |
| Mainnet executor binary mismatch with verifiable build (P1-9) | Hold mainnet flip until P1-9 verifiable build is wired |

## Rollback plan

If Phase E or F surfaces a P0:

1. Flip `EXECUTOR_SWAP_ENABLED=false` in API env. Pool browser reverts to SOL-only within 1 deploy cycle.
2. Pause executor program via `set_paused` (existing P0-5 mechanism).
3. Recovery worker reconciles in-flight positions: positions in `swap_executing` advance to `swap_indexing` on confirmation, then either continue to `executing_on_meteora` or fail cleanly.
4. Open incident in `runbooks/incident/swap-failure.md`.
5. Hot-fix or revert; rerun Phase B before resuming.

## Definition of done

- All gates passed.
- All readiness-doc cross-refs updated.
- 30 days of mainnet stability with default-on.
- Plan archived; lessons-learned added to `docs/plans/meteora-swap-layer/post-mortem.md`.
