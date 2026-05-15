# Octora — Dust Handling & Stuck-Funds Design

Two coupled problems: (1) non-fixed amounts on withdraw + fee-claim, (2) user fails to add liquidity after successful mixer deposit.

## Problem 1 — Non-fixed amounts / dust

### Root cause

Stealth wallet sits between mixer-withdraw and pool-deposit. Gap = where dust appears + linkage leak surface. Sweep service is a band-aid, not a fix.

### Best fix — Atomic compound instruction

One tx, CPI-chained:

```
mixer.withdraw -> pool.add_liquidity
       \-> position NFT owner = stealth
       \-> sub-denom dust never lands in stealth account
```

- Withdraw lamports → pool position in single ix-batch
- Fee = paid by relayer, deducted from denom inside the CPI
- No intermediate "stealth holds 4.97 SOL" state → no sweep needed
- Bot sees: relayer signs, denom in, position out. No dust trail.

### Fee-claim path

`pool.claim_fee -> mixer.deposit` in one tx:

- Round-down claimed fees to nearest denom multiple (e.g. 0.1 SOL)
- Floor portion → fresh mixer commitment (new anonymity set entry)
- Residual sub-denom dust → **compound back into position** (not swept, not paid out). Stays inside LP, grows next claim.
- No off-chain sweeper. No protocol treasury siphon. User funds never leave their own LP.

### Denom ladder (smaller buckets)

- Add ladder: `{0.1, 1, 5, 10}` SOL
- Smaller bucket = less residual after LP price-range fit
- Tradeoff: more buckets fragment anonymity sets
- Mitigate: enforce `MIN_ANONYMITY_SET=20` per bucket, hide empty buckets in UI until filled

### Alternative if atomic CPI infeasible

> **Note-based change (Zcash-style):** withdraw emits `(denom_note - fee_note)`. User redeposits `fee_note` later when accumulated to denom.
>
> Heavier crypto. Only if atomic CPI blocked by program size / CU.

**Recommendation:** atomic compound ix + denom ladder + floor-round on fee-claim. Kills dust without sweeper.

## Problem 2 — Mixer deposit success → add-LP fail

### Reframe: not actually stuck

User holds nullifier secret → user holds funds. Mixer is custodial-less. "Stuck" = UX gap, not protocol gap.

### Best fix — Atomic deposit + add-LP in one tx

```
user.sign:
  mixer.deposit (commitment)
  CPI -> pool.add_liquidity (via relayer-derived stealth or PDA)
```

- LP fail → whole tx reverts → SOL never left user wallet
- Eliminates the stuck state by construction

> **Constraint:** tx size + CU budget must fit both ix. DLMM `addLiquidity` is heavy → may need to split bin-array init into prep tx (non-fund-moving, safe to fail).

### If atomic infeasible — Two-phase with persisted intent

1. `deposit` → backend stores `{commitment, intended_pool, denom, expires_at}` keyed by nullifier hash (user holds preimage)
2. Frontend immediately attempts `withdraw + add_liquidity` (atomic from stealth)
3. On fail: UI surfaces 3 paths:
   - **Retry** — re-run withdraw+LP, same denom, different pool / params
   - **Withdraw to new stealth** — treat as parked funds, use later
   - **Auto-retry** — backend relayer retries N times with backoff
4. State machine:

   ```
   DEPOSITED -> LP_PENDING -> LP_FAILED -> { LP_RETRIED | PARKED | WITHDRAWN }
   ```

### Edge case — relayer disappears mid-flow

- Nullifier must be revealable to user directly (not just relayer)
- UI: **"Recover funds"** button → user-signed withdraw to any stealth they control, paying own fee
- Worst case but always available `SAFE`

**Recommendation:** atomic deposit+LP if CU fits; otherwise two-phase with retry UI + always-available user-signed recover path. Persist intent server-side. No funds ever truly stuck.

## State machine summary

| State | Trigger | Next | UI affordance |
|-------|---------|------|---------------|
| `DEPOSITED` | mixer.deposit confirmed | `LP_PENDING` | "Adding liquidity…" |
| `LP_PENDING` | withdraw+addLP submitted | `LP_DONE` / `LP_FAILED` | spinner |
| `LP_FAILED` | tx revert / timeout | retry / park / withdraw | 3-button panel |
| `PARKED` | user chose "later" | resume anytime | "Resume in pool" CTA |
| `WITHDRAWN` | user-signed recover | terminal | tx receipt |
| `LP_DONE` | position NFT minted | terminal | position view |

## Order of work

1. Prototype atomic `deposit + addLiquidity` — measure CU. Decide single-tx vs two-tx.
2. Add denom ladder + floor-round fee-claim path.
3. Build `LP_FAILED` state machine + "Recover funds" user-signed fallback.
4. Drop sweeper from roadmap — replaced by atomic compounding.
