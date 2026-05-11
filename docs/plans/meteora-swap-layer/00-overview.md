# Meteora Swap Layer — Implementation Overview

**Goal:** Add a `swap_via_dlmm` step to the executor flow so the stealth wallet can convert SOL into the target LP token via Meteora DLMM, before calling `add_liquidity`. This unlocks support for *any* Meteora DLMM pair (including memecoins) while keeping the mixer SOL-only and avoiding Jupiter as a privacy-perimeter dependency.

**Constraint:** The swap source pool must NOT equal the LP target pool (avoids self-front-running, see §"The trap" in the architecture discussion).

**Scope of this plan:** 4 layered work-streams. Each has its own plan file:

| # | File | Layer | Owner | Effort |
| - | ---- | ----- | ----- | ------ |
| 1 | `01-program-swap-instruction.md` | Anchor program (`octora-executor`) | Eng (Solana) | 3–5 days |
| 2 | `02-backend-orchestration.md` | API + state machine + recovery | Eng (Backend) | 3–4 days |
| 3 | `03-frontend-ux.md` | Web UI + intent flow + ToS bump | Eng (Frontend) | 2–3 days |
| 4 | `04-rollout-and-testing.md` | Devnet shakedown + feature flag + audit pack | Eng + Ops | 2–3 days + 1wk obs |

**Total:** ~10–15 engineer-days + 1 week devnet observation before mainnet flip.

## End-state architecture

```
Main wallet
    │ (SOL deposit)
    ▼
┌──────────────────────┐
│  SOL Mixer           │  one pool, deep anonymity set
└──────────────────────┘
    │ (relayer pays fresh stealth)
    ▼
Stealth wallet  ◄────── identity boundary
    │
    │ swap_via_dlmm  (Meteora DLMM swap on a *different* pool)
    │   • source pool ≠ target pool (enforced)
    │   • slippage controlled by user
    │   • atomic with subsequent LP if possible
    ▼
Stealth wallet (now holds SOL + target token)
    │
    │ add_liquidity  (target Meteora DLMM pool)
    ▼
Active LP position
```

On exit (mirror, covered separately by P0-NEW-I in `runbooks/PRODUCTION_READINESS.md`):

```
Active LP → close_position → stealth holds SOL + token
    → swap back to SOL on a non-target pool
    → mixer deposit (stealth → mixer)
    → relayer withdraw (mixer → main)
```

## Hard rules (encoded as constraints across plans)

1. **Same-pool reject.** Backend + program both refuse if `swap.lb_pair == lp.lb_pair`.
2. **Pause gate.** New `swap_via_dlmm` instruction respects `Config.paused` like every other ix.
3. **Signer hygiene.** `stealth: Signer<'info>` + `#[account(mut)]` (don't repeat the P0-NEW-A oversight).
4. **CPI re-pin.** PoolAuthority PDA is re-pinned in the infos vector before `invoke_signed` (same pattern as `add_liquidity.rs:114–118`).
5. **No Jupiter in the privacy boundary.** This plan scope is Meteora-only. Jupiter as a fallback for thin-liquidity tokens is out of scope (separate future plan).
6. **No DAMM.** All references to DAMM in this plan are explicit prohibitions; DAMM modules are being deleted under P0-NEW-A.

## Related readiness items

| Readiness ID | Relation |
| --- | --- |
| P0-NEW-A | DAMM removal — must complete before this plan ships |
| P0-NEW-I | Symmetric private exit — uses the swap path defined here |
| P1-10 | `ROOT_HISTORY_SIZE` bump — independent but should land in same release window |
| P2-19 | MEV / slippage on add_liquidity — extend to swap step |
| P1-48 | Anchor tests in CI — add new swap tests to the suite |

## Sequencing

```
P0-NEW-A (DAMM delete) ──┐
                         ├──► Plan 1 (program) ──► Plan 2 (backend) ──► Plan 3 (frontend) ──► Plan 4 (rollout)
P0-2 ceremony complete ──┘
```

DAMM deletion lands first to keep the executor lean and avoid IDL noise during swap-ix audit. Trusted setup ceremony (P0-2) does NOT block this plan but DOES block any mainnet deploy that uses the resulting binary.

## Out of scope

- Jupiter aggregation (future)
- Multi-hop swaps (future)
- Cross-pool atomic execution beyond a single tx
- Off-chain price oracles
- DAMM swap (program being removed)
- Token-2022 hooks beyond what `add_liquidity` already supports
