# Octora — core program features MVP plan

**Three core flows that deliver the privacy promise end-to-end:**

1. **Private add-liquidity** — main wallet → mixer → stealth wallet → swap → DLMM
2. **Private claim fees** — stealth claims fees from DLMM → swap → mixer → relayer → main
3. **Private withdraw** — stealth closes position → swap → mixer → relayer → main

If only one of these is private, the privacy product is broken. All three must ship together for beta.

This file is the *what* and *where* for each feature. The *when* is in `MVP_LAUNCH_PLAN.md`. The *how-to-set-up* is in `runbooks/manual-setup/`.

---

## 0. Target user and LP strategy — read first

**Persona:** degen LP user who plays meme coin pairs against SOL on Meteora. They want their main wallet hidden so copy-trade bots and chain analysts can't:
- Front-run their entry into a meme coin position.
- Identify them as the LP behind a profitable position.
- Pattern-match their wallet across positions to fingerprint their strategy.

**LP shape:** single-sided SOL only. The user deposits SOL, LPs into bins **above** the active price (or below, depending on which side SOL sits on per DLMM lex-ordering). As price moves through, bins fill with the meme coin — passive sell-the-rip. On exit, the position holds a mix of SOL (untouched bins) + MEME (filled bins) + accrued fees.

This is enforced in code: `octora-api/src/modules/executor/single-sided.ts` says "MVP only supports single-sided SOL deposits." Two-sided LP is post-MVP.

**Implication for swap mechanism:**
- **Deposit edge:** no swap needed. User deposits 1 SOL via mixer, the stealth wallet receives 1 SOL, LPs single-sided 1 SOL into the chosen bin range. Done.
- **Exit edge:** swap needed. After `withdraw_close`, the stealth ATAs hold SOL + MEME + (sometimes) reward tokens. MEME must be swapped to SOL before re-entering the mixer.

**Critical: the swap-pool-resolver invariant must allow same-pool fallback.** Today's `swap-pool-resolver.ts` enforces "source pool ≠ LP target" to prevent self-front-running on entry. That's correct for SOL/USDC-style pairs. But for meme coins, the LP target is almost always the *only* SOL-paired Meteora pool. Refusing same-pool means refusing private exit for nearly every meme position — the product doesn't work for our target user.

The amended rule (Day 7): try deepest non-target pool first; fall back to LP target when no alternative exists. Self-front-run impact on exit is bounded by your own `min_amount_out`. The decision is documented in `docs/plans/meteora-swap-layer/` so future maintainers know it's intentional.

**Critical: slippage UX must NOT mirror Meteora's misleading "Price Impact %" display.** Meteora's UI shows price impact without accounting for slippage protection, which gives users a falsely tight number. Octora's UI shows two values: "Estimated to receive" (mid-market post-fee) and "Minimum guaranteed" (after slippage protection). Default slippage 5 % for meme coins; slider exposed for user override 0.1 % – 20 %. Protocol-level `min_amount_out` enforces it; if exceeded the swap reverts and recovery worker handles it.

## 0.5 Critical design constraint — read second

The executor program's `claim_fees.rs` and `withdraw_close.rs` route DLMM proceeds to `PoolAuthority.exit_recipient`, which is set at `init_position` time and stored in the `PoolAuthority` PDA. If `exit_recipient = main_wallet`, every claim and close publicly links the stealth wallet to the main wallet.

**Therefore: `exit_recipient` must be set to the stealth wallet itself.** All DLMM proceeds land at the stealth's ATA, then the orchestration layer (API + browser) moves them through the mixer to the user's main wallet privately.

This is a one-line change in the API's `dlmm_init_position` builder — no program upgrade needed since `exit_recipient` is already a parameter — but every UI flow downstream depends on this assumption being true. Lock it in Day 1.

## 1. Cross-cutting prerequisites

These must be in place before any of the three features works end-to-end. Most are already shipped; the Day reference points to `MVP_LAUNCH_PLAN.md`.

| Prereq | Status | Day |
| --- | --- | --- |
| Three multi-denomination mixer pools (0.1, 1, 10 SOL) | ❌ Code + init script | Day 1 |
| Anonymity-set gate (`MIN_ANONYMITY_SET=20`) per pool | ❌ Service-layer | Day 2 |
| Persistent slot-based privacy delay | ✅ Shipped (P0-15) | — |
| KMS-backed relayer signer (segregated wallets, alarms) | ❌ Days 2–4 | Days 3–4 |
| Squads multisig holding upgrade authority | ❌ | Day 14 |
| Trusted setup ceremony executed | ❌ | Day 11 |
| Server-side ToS ack | ❌ P2-NEW-D | Day 4 |
| Stealth wallet pre-deposit modal + export-seed UX | ❌ P1-38 | Days 3–4 |
| Frontend Sentry + error boundaries | ❌ P1-30, P1-37 | Days 2–3 |
| Slippage + `min_out` user-controlled | ❌ P2-19 | Day 8 |
| Symmetric anonymity policy applied to exits | ❌ P1-18 | Day 8 |
| `exit_recipient = stealth` enforced at init_position | ❌ this doc | Day 6 |

If any prereq is red, the corresponding feature flow is not actually private.

## 2. Feature 1 — Private add-liquidity

**User story:** I deposit SOL from my main wallet into Octora. After a privacy delay, my LP position is opened on Meteora DLMM by a stealth wallet whose link to my main wallet is hidden by the mixer.

**One-line outcome:** main wallet has SOL → main wallet has an LP position visible on the portfolio page; nothing on-chain links the LP position back to the main wallet.

### 2.1 Current state

- `octora-mixer.deposit` instruction ✅ (commitment, Merkle insertion, event)
- Stealth wallet derivation in browser ✅ (`octora-web/src/lib/stealthVault.ts`)
- `octora-mixer.withdraw` with proof verification ✅ (recipient bound)
- Relayer service that submits the withdraw ✅ (`octora-api/src/modules/relayer/`)
- `octora-executor.dlmm_init_position` ✅
- `octora-executor.dlmm_add_liquidity` ✅
- `PrivateDepositModal.tsx` exists ⚠ (needs multi-denom + anonymity UX)
- Position state machine through `executing_on_meteora` ✅
- Indexer reconciliation ✅
- Recovery worker ✅

### 2.2 Gaps for MVP

| Gap | Layer | Owner |
| --- | --- | --- |
| Multi-denomination init script seeds three pools at deploy time | Programs / scripts | Engineer A |
| `/mixer/pools` endpoint returns `[{ denomination, anonymitySet, depositCount, isPaused }]` | API | Engineer A |
| Anonymity-set ≥ 20 enforcement at withdraw build time | API | Engineer A |
| Denomination selector in `PrivateDepositModal.tsx` | Frontend | Engineer B |
| Anonymity-set inline indicator per pool | Frontend | Engineer B |
| Pre-deposit stealth-wallet explainer (first-time per session) | Frontend | Engineer B |
| Set `exit_recipient = stealth` (not main) in `dlmm_init_position` builder | API / Frontend | Engineer A + B |
| Slippage control on swap-to-pair-token step | API + Frontend | Days 7–8 |
| Anonymity-set warning when selected pool has < 20 deposits | Frontend | Engineer B |

### 2.3 Program work (Engineer A)

- **Day 1, 30 min:** raise `ROOT_HISTORY_SIZE` 30 → 256 in `programs/octora-mixer/src/constants.rs`. Update `MixerPool::SPACE`. Redeploy on devnet, confirm tests pass.
- **Day 1, 2 h:** multi-pool init script — `scripts/init-mixer-pools.ts` initializes three `MixerPool` accounts at denominations `100_000_000`, `1_000_000_000`, `10_000_000_000` lamports. Idempotent (no-op if pool already exists).
- **Day 1, 3 h:** delete `programs/octora-executor/src/instructions/damm/` (P0-NEW-A). Regenerate IDL, rebuild, redeploy on devnet.
- **Day 12, 30 min:** add `!is_signer && !is_executable` to `require_rent_sysvar` (P3-NEW-B).

No further program changes for this feature.

### 2.4 API work (Engineer A)

- **Day 2, 3 h:** `MIN_ANONYMITY_SET=20` enforcement in `octora-api/src/modules/mixer/mixer.service.ts`. Read on-chain `next_leaf_index` minus active nullifier count for the selected pool. Reject withdraw build with error code `ANONYMITY_SET_TOO_THIN`, payload `{ current, required, denomination }`.
- **Day 2, 2 h:** `GET /mixer/pools` endpoint returning `[{ denomination, anonymitySet, depositCount, withdrawalCount, isPaused }]`. Cached 30 s.
- **Day 6, 1 h:** `POST /executor/init-position-tx` builder — change `exit_recipient` parameter binding so it's always the stealth wallet pubkey, not the user's main wallet. Add unit test asserting the built tx's `exit_recipient` argument equals the stealth pubkey.
- **Day 7, 4 h:** extend the existing `octora-api/src/modules/executor/swap.service.ts` (already wired to Meteora DLMM via `DlmmSwapClient` and `swap-pool-resolver.recommendSwapSource`). Two changes: (a) add the exit-side direction — for each non-SOL token returned by `withdraw_close`, build a Meteora swap to SOL; (b) **amend `swap-pool-resolver` to allow same-pool fallback when no alternative SOL-paired pool exists for that mint** (required for meme coin pairs — see §0). Resolver now returns either a different-pool candidate or, as a labeled fallback, the LP target itself. Caller passes `allowSameTargetFallback: true` for exit swaps; deposit-side keeps the strict rule (since deposit-side single-sided SOL doesn't need a swap at all). Slippage cap remains `MAX_SLIPPAGE_BPS=2000` per the existing constant. Note: deposit-side swap is **not invoked** in the MVP single-sided SOL flow — no half-half conversion happens on entry.

### 2.5 UI/UX work (Engineer B) — `octora-web/`

#### `PrivateDepositModal.tsx`

State chart:

```
explainer (first-time only)
   ↓
tos-ack (first-time per version)
   ↓
denomination-select (0.1 / 1 / 10 SOL pills, anonymity badges)
   ↓
position-config (single-sided SOL bin range — width + offset above/below active price; preview of which bins fill in which price scenarios)
   ↓
review (summary; estimated time; mixer fee; relayer fee; gas; "no entry-side swap — your SOL stays SOL until price moves through your bins")
   ↓
sign (main wallet signs deposit tx via wallet adapter)
   ↓
progress
   ├─ depositing (waiting for confirmation)
   ├─ mixing (privacy delay countdown — slots remaining + estimated time)
   ├─ relayer-dispatching (proof generated + submitted; spinner)
   ├─ stealth-funded (tx confirmed on chain)
   └─ adding-liquidity (executor + DLMM CPI; single-sided SOL deposit, no swap)
   ↓
success (position card + "View position" CTA + activity entry)
```

Components:

- **`DenominationSelector.tsx`** — three pills, each shows `D · anon set N`. Disabled state when pool is paused or full. Warning state when `N < 20`.
- **`AnonymityBadge.tsx`** — `≥20 ✓` (teal), `5–19 ⚠` (amber), `<5 ✗` (coral). Click reveals tooltip explaining.
- **`PrivacyDelayTimer.tsx`** — countdown using slots remaining; converts to estimated minutes via average slot time.
- **`ProgressStepper.tsx`** — six states above; current state highlighted; previous states checked; future states muted. Failed state shows recovery affordance.

Validation:

- Cannot proceed past `denomination-select` if selected pool has `anonymitySet === 0` (would be the very first deposit; user is told they'd be N=1 of 1 and asked to wait or pick a more active pool).
- Bin range must satisfy single-sided invariant — `planSingleSidedSol` enforces upper-bin-id < active-bin-id (SOL = tokenY) or lower-bin-id > active-bin-id (SOL = tokenX). UI presets: "narrow" (10 bins), "medium" (30 bins), "wide" (70 bins). Wider = more capture range, slower fill, bigger position size before re-entry.
- No deposit-side slippage control — there is no entry swap.
- Cannot exceed `BETA_MAX_POSITION_SOL` per position or `BETA_MAX_GLOBAL_TVL_SOL` cumulative.

#### `PoolDetailPage.tsx`

- Pool stats — TVL, APR, recent volume, fee tier, current price.
- "Add liquidity privately" CTA opens `PrivateDepositModal`.
- Anonymity-set indicator per available denomination.
- Existing position warning if user already has one in this pool.

#### `PoolsPage.tsx`

- Searchable list of available DLMM pools.
- Filter chips: token pair, fee tier, price range.
- Per-row anonymity-set indicator showing the most-active mixer denomination.

#### Cross-cutting frontend additions

- **`StealthExplainerModal.tsx`** — first-time-per-session pre-deposit modal. Explains: stealth wallet is browser-derived, ephemeral, recoverable only by signing the same authorize message in another browser. Link to docs. "I understand" + "Export seed" buttons.
- **`StealthSeedExportModal.tsx`** — re-runs the authorize signature, surfaces the derived ed25519 seed words. Warning that anyone with the user's main wallet + the authorize message recovers the seed.
- **`TosAckModal.tsx`** (already exists) — extend to call `POST /auth/ack-tos` server-side per P2-NEW-D.

### 2.6 State machine (additions to existing)

No additions for add-liquidity — uses existing path:

```
draft → awaiting_signature → funding_in_progress → executing_on_meteora → indexing → active
```

State machine guards already enforce monotonic progression.

### 2.7 Tests

- **Unit (Engineer B, Day 5):** `PrivateDepositModal` state transitions; denomination selector enables/disables correctly; anonymity warning shows for low-N pool.
- **Integration (Engineer A, Day 5):** `MIN_ANONYMITY_SET` rejection; `/mixer/pools` returns expected shape per pool; `init-position-tx` builder sets `exit_recipient = stealth`.
- **E2E (Day 5):** Playwright — connect wallet → ToS ack → select 1-SOL denomination → deposit → privacy delay (mocked or real on devnet) → relayer → stealth funded → swap → LP added → position visible on portfolio page. No on-chain transfer between main and stealth except via mixer.

### 2.8 Acceptance

Feature 1 is done when:
- Three pools (0.1, 1, 10 SOL) initialized on devnet and selectable in UI.
- Anonymity-set gate enforced; UI surfaces shortfall.
- `exit_recipient` is always stealth (verified by unit + integration test).
- Full happy path completes on devnet for at least one denomination per pool.
- Failure modes tested: stealth swap fails, RPC slow, browser refresh mid-flow.
- Sentry receives breadcrumbs for every state transition (with PII redacted).

---

## 3. Feature 2 — Private claim fees

**User story:** my LP position has accrued fees in tokens A and B. I want to move those fees to my main wallet without anyone observing on-chain that the stealth wallet that earned them connects to my main wallet.

**One-line outcome:** stealth claims fees → privately routed → main wallet receives canonical SOL value of the fees.

### 3.1 Current state

- `octora-executor.dlmm_claim_fees` instruction ✅
- API endpoint to build claim_fees tx ✅ (`/executor/claim-fees-tx` per `executor.controller.ts`)
- Frontend hook to call it ⚠ (basic; does NOT route through mixer privately)
- Position state machine has `claiming` state ✅
- **Currently fees would land at `exit_recipient` directly** — this is the privacy gap

### 3.2 Gaps for MVP

| Gap | Layer | Owner |
| --- | --- | --- |
| `exit_recipient = stealth` (covered in §2 prereq) | API | Engineer A |
| Orchestration: claim → stealth ATA → swap → mixer → relayer → main | API | Engineer A |
| State machine extension: `claiming → claim_swap_pending → claim_mixer_pending → claim_relayer_dispatched → finalized` | Domain + API | Engineer A |
| `POST /positions/:id/private-claim` endpoint that drives the orchestration | API | Engineer A |
| Recovery worker covers stuck claim states | API | Engineer A |
| Minimum-claim threshold (≥ smallest pool denomination) | API + UI | Engineer A + B |
| `PrivateClaimModal.tsx` | Frontend | Engineer B |
| Position card shows accrued fees + "Claim privately" CTA | Frontend | Engineer B |
| Receipt UI showing fees received at main wallet | Frontend | Engineer B |

### 3.3 Program work

**None.** The existing `dlmm_claim_fees` instruction is sufficient. The privacy is achieved by setting `exit_recipient = stealth` at `init_position` time, then doing the orchestration off-chain via the API.

### 3.4 API work (Engineer A) — Days 7–8

- Extend domain state machine `octora-api/src/domain/state-machine.ts` with new states for the private-claim flow:
  - `active → claim_pending` — user requested claim
  - `claim_pending → claim_swap_pending` — stealth claimed; tokens received at stealth ATA
  - `claim_swap_pending → claim_mixer_deposit_pending` — Meteora DLMM swap submitted
  - `claim_mixer_deposit_pending → claim_privacy_delay` — mixer deposit confirmed; awaiting privacy delay
  - `claim_privacy_delay → claim_relayer_dispatched` — delay elapsed; relayer submitting
  - `claim_relayer_dispatched → active` — relayer confirmed; fees in main wallet; position remains active
  - any → `claim_failed` (with `FailureStage`)
- Repository methods to advance these states.
- `POST /positions/:id/private-claim` controller — checks position is in `active` state, accumulated fees ≥ smallest pool denomination, anonymity set OK, kicks off orchestration.
- Orchestration runs as a job sequence (Engineer A picks: BullMQ, in-memory queue with periodic worker like the existing recovery worker, or the simple "drive on next API call" pattern). Recovery worker handles stuck states with the same shape as the existing worker.
- Reuse swap service from §2 (same `swap.service.ts`).
- Reuse mixer deposit + withdraw infrastructure from Feature 1.

### 3.5 UI/UX work (Engineer B) — Days 7–8

#### `PrivateClaimModal.tsx`

State chart:

```
review (accrued fees in token A + B; estimated SOL after swap; mixer + relayer fees; estimated time)
   ↓
anonymity-check (warning if pool too thin; user can wait or proceed)
   ↓
confirm (user accepts; modal does NOT need wallet sign — stealth signs in browser)
   ↓
progress
   ├─ claiming (executor.claim_fees CPI)
   ├─ swapping (stealth → Meteora DLMM → SOL, one leg per non-SOL token)
   ├─ depositing (mixer.deposit)
   ├─ mixing (privacy delay countdown)
   ├─ relayer-dispatching
   └─ finalizing
   ↓
receipt (amount received at main wallet, time taken, mixer + relayer fees deducted)
```

Components:

- Same `ProgressStepper.tsx` as Feature 1 (six states differ but same component).
- **`AccruedFeesPanel.tsx`** — on `PositionDetailPage.tsx` showing token A + token B amounts, last-claimed timestamp, "Claim privately" CTA.
- **`PrivacyVsDirectClaimToggle.tsx`** — explicit comparison: "Direct claim (links your stealth to main wallet, ~5 s)" versus "Private claim (recommended, ~10 min)." Direct claim is hidden behind a "show advanced" disclosure to discourage casual use.

#### `PositionDetailPage.tsx` (additions)

- Accrued fees section with claim CTA.
- State badge showing current claim state if a claim is in progress.
- Activity log entries for each claim transition.

### 3.6 State machine

```
                   active
                     │
    ┌────────────────┼────────────────┐
    │                │                │
 claim_pending   withdraw_pending   ...
    │
 claim_swap_pending
    │
 claim_mixer_deposit_pending
    │
 claim_privacy_delay
    │
 claim_relayer_dispatched
    │
    └──────▶ active (fees in main wallet)

any non-terminal → claim_failed (FailureStage)
```

The position itself returns to `active` after a successful claim — the LP position is not closed, only the fees are extracted.

### 3.7 Tests

- **Unit:** state machine transitions; accumulated-fees threshold check.
- **Integration:** swap quote → mixer deposit → relayer withdraw chained without intermediate API restart.
- **E2E:** open position → simulate fee accrual on devnet → trigger private claim → main wallet receives expected SOL value (within slippage).
- **Failure cases:** RPC drops mid-swap (recovery worker resumes); browser closed during anonymity-delay (job survives); main wallet receives less than expected (slippage logged).

### 3.8 Acceptance

Feature 2 is done when:
- Private claim end-to-end on devnet returns funds to main wallet.
- Solana Explorer graph confirms no direct stealth → main transfer.
- Recovery worker handles each state's stuck case.
- UI shows accurate progress, accurate final amounts.
- Failure scenarios tested.
- Minimum-claim threshold enforced (≥ smallest pool D, default 0.1 SOL).

---

## 4. Feature 3 — Private withdraw (symmetric exit)

**User story:** I want to close my LP position and get my SOL back to my main wallet without on-chain observers being able to link the stealth wallet (which closed the position) to my main wallet (which received the proceeds).

**One-line outcome:** stealth wallet closes the DLMM position → privately routed via mixer → main wallet receives canonical SOL value of the position.

### 4.1 Current state

- `octora-executor.dlmm_withdraw_close` instruction ✅
- API endpoint stub ⚠ (`/executor/withdraw-close-tx` exists; routes to `exit_recipient` which is currently main wallet — that's the privacy break)
- Position state machine has `withdrawing → closing → completed` ⚠ (not symmetric-exit aware)
- This is `P0-NEW-I` from the audit — the largest single MVP build.

### 4.2 Gaps for MVP

| Gap | Layer | Owner |
| --- | --- | --- |
| `exit_recipient = stealth` (already covered in §2 prereq) | API | — |
| State machine extension: `closing → exit_swap_pending → exit_mixer_deposit_pending → exit_privacy_delay → exit_relayer_dispatched → completed` | Domain + API | Engineer A |
| `POST /positions/:id/private-exit` endpoint | API | Engineer A |
| Heterogeneous-asset handling — DLMM returns token A + B + reward tokens; consolidate via Meteora DLMM swap (existing `swap.service.ts` + `swap-pool-resolver`) to canonical D | API | Engineer A |
| Recovery worker covers stuck exit states | API | Engineer A |
| Dust handling — residue below smallest pool D | API + UI | Engineer A + B |
| `PrivateExitModal.tsx` | Frontend | Engineer B |
| Position detail page: "Close position" CTA splits into "Direct close" vs "Private exit (recommended)" | Frontend | Engineer B |
| Symmetric anonymity policy on exit deposits | API | Engineer A |
| Exit-side `BetaAccess` cap accounting (don't double-count exit deposits against TVL cap) | API | Engineer A |
| Final receipt UI showing deltas | Frontend | Engineer B |

### 4.3 Program work

**None.** Same logic as Feature 2 — `exit_recipient = stealth` flips the destination, and orchestration handles the rest in the API.

### 4.4 API work (Engineer A) — Days 6–8

Days 6–7 are the bulk of this work.

- Domain state machine extension:
  - `active → exit_pending` — user requested close
  - `exit_pending → exit_dlmm_executing` — `withdraw_close` submitted
  - `exit_dlmm_executing → exit_swap_pending` — DLMM proceeds at stealth ATA
  - `exit_swap_pending → exit_mixer_deposit_pending` — Meteora DLMM swap done; mixer deposit submitted
  - `exit_mixer_deposit_pending → exit_privacy_delay` — mixer deposit confirmed
  - `exit_privacy_delay → exit_relayer_dispatched` — delay elapsed; relayer in-flight
  - `exit_relayer_dispatched → completed` — relayer confirmed; final state

- Heterogeneous-asset consolidation (Day 7) — when `withdraw_close` returns:
  - SOL (or wSOL after unwrap)
  - SPL token A (the non-SOL side of the LP)
  - Optional reward tokens (depends on pool config)

  Strategy: chain Meteora DLMM swaps via `swap-pool-resolver.recommendSwapSource(allowSameTargetFallback: true)` to consolidate everything into native SOL. For each non-SOL token, the resolver picks the deepest SOL-paired DLMM pool — preferring a non-target pool, falling back to the LP target itself when no alternative exists (the meme coin case). Acceptable slippage default **5 % for meme coins** (was 0.5 % before the degen-LP pivot — that was wrong for our user persona), configurable up to 20 % per `MAX_SLIPPAGE_BPS=2000` in `swap.service.ts`.

  Failure handling: with same-pool fallback enabled, the meme coin itself almost always has a swap path (since it's the LP target). The remaining `NoSwapSourceAvailableError` cases are reward tokens with **no** SOL-paired Meteora pool anywhere — neither alternative nor target. For those, the orchestration **does not silently fall back to a riskier path**. It leaves the reward token at the stealth wallet as stranded value, surfaces it via the dust panel (§4.5), and proceeds with the swappable portion. The meme coin component itself reliably exits.

  Self-front-run impact (same-pool fallback case): your exit swap moves the pool price downward against you. The bound is `min_amount_out`. For typical meme coin position sizes (≤ 10 SOL of MEME against pools with ≥ 100 SOL TVL) the slippage is under 5 %. For larger positions vs. thinner pools, slippage may force the swap to revert; user is asked to bump the slippage slider or exit in chunks via partial-close (post-MVP) or by manually staging multiple smaller exits.

- Dust handling (Day 8) — once consolidated, if the SOL value is between two denominations (e.g., 4 SOL when pools are 0.1 / 1 / 10), floor to the largest denomination that fits, leave residue at stealth. UI is explicit about this; user can private-exit the residue later when it accumulates above the smallest pool, or sweep manually (with privacy warning). Same panel surfaces stranded reward tokens from `NoSwapSourceAvailableError` cases.

- Cap accounting — exit deposits to mixer must NOT increment the user's TVL counter (the user is *withdrawing*, not adding new value). Add `isExitDeposit: boolean` flag on the deposit-tx-build path; bypass the cap check.

- Recovery worker — covers stuck states with same pattern as existing positions worker.

- `POST /positions/:id/private-exit` controller — verifies position is in `active`, kicks off orchestration.

### 4.5 UI/UX work (Engineer B) — Days 6–9

#### `PrivateExitModal.tsx`

State chart:

```
explanation (first-time per user — what private exit is and why ~10 min)
   ↓
review (current position value: LP tokens + accrued fees + rewards, all priced in SOL; estimated final SOL after swap + mixer + relayer fees; estimated time; dust warning if applicable)
   ↓
direct-vs-private-toggle (default = private; explicit warning that direct breaks privacy)
   ↓
confirm (no wallet sign needed for private path — stealth signs all subsequent steps in browser; for direct path, wallet sign needed)
   ↓
progress
   ├─ closing (executor.withdraw_close)
   ├─ swapping (Meteora DLMM consolidation, one leg per non-SOL token)
   ├─ depositing (mixer.deposit, exit-side)
   ├─ mixing (privacy delay countdown)
   ├─ relayer-dispatching
   └─ finalizing
   ↓
receipt (final SOL received, original deposit, fees earned, slippage incurred, total time)
```

Components:

- **`PrivacyVsDirectExitToggle.tsx`** — large, explicit. Direct exit shows "Bypass privacy: stealth → main directly. Saves ~10 min, but anyone watching the chain will see your LP position and your main wallet are the same person." Click-through-to-direct requires a second confirmation.
- **`DustWarningPanel.tsx`** — surfaces two distinct cases. (a) Denomination residue: "Your position is worth 4.2 SOL. Mixer pools come in 0.1, 1, and 10 SOL units. We will route 4 SOL through the mixer and leave 0.2 SOL in your stealth wallet to avoid linking. You can private-exit that residue when it accumulates over time, or sweep it manually (will link)." (b) Stranded tokens: "0.018 REWARD-TOKEN cannot be swapped privately — no Meteora SOL-paired pool exists for this token other than your LP target. Funds remain in your stealth wallet; manual claim available with linking warning."
- **`ExitProgressTimer.tsx`** — shows expected wait + actual elapsed.

#### `PositionDetailPage.tsx` (additions)

- "Close position" CTA → splits into:
  - "Private exit (recommended, ~10 min)"
  - "Direct close (links wallet, ~5 s)" — small text, not a button-equivalent
- State badge during exit progresses through new states.
- Activity log entries.

### 4.6 State machine

```
active
   │
 exit_pending
   │
 exit_dlmm_executing
   │
 exit_swap_pending
   │
 exit_mixer_deposit_pending
   │
 exit_privacy_delay
   │
 exit_relayer_dispatched
   │
   └────▶ completed

any non-terminal → failed (FailureStage)

Failure stages (new):
  EXIT_DLMM_FAILED     — withdraw_close reverted
  EXIT_SWAP_FAILED     — Meteora DLMM swap slippage exceeded OR NoSwapSourceAvailableError
  EXIT_MIXER_FAILED    — mixer deposit failed
  EXIT_RELAYER_FAILED  — relayer submission failed (most likely RPC)
```

### 4.7 Tests

- **Unit:** state transitions; cap accounting (exit deposit doesn't bump TVL counter); dust calculation correct.
- **Integration:** full chain on devnet — from `active` to `completed`, each state confirmed.
- **E2E:** Playwright — opens position, accrues some state, triggers private exit, walks all UI states, asserts final SOL on main wallet matches expected within slippage. Solana Explorer graph traversal confirms no direct stealth → main path.
- **Failure cases:**
  - DLMM `withdraw_close` reverts — recovery worker offers retry or fail-with-recovery-instructions.
  - Meteora DLMM swap slippage exceeded — recovery worker resumes when slippage normalizes, OR user can manually re-trigger with higher slippage. If `recommendSwapSource` returns no candidate (`NoSwapSourceAvailableError`), the orchestration leaves that token at the stealth wallet as stranded value and continues with the swappable portion (surfaced in dust panel).
  - Mixer deposit lands but relayer fails — funds are recoverable; user can re-trigger relayer step or fall back to self-submit (post-MVP).
  - Browser closed mid-flow — orchestration is server-driven; user reloads, sees current state on position detail, can continue.

### 4.8 Acceptance

Feature 3 is done when:
- Private exit on devnet completes for each of the three denominations.
- No on-chain transfer between stealth and main exists outside the mixer path (verified by graph traversal in test).
- Heterogeneous-asset consolidation works (LP returning A + B + rewards all reach main wallet as SOL).
- Dust handling matches spec; UI surfaces clearly.
- Each failure mode has a tested recovery path.
- Recovery worker covers all stuck states.
- TVL cap accounting tested — exit deposit does NOT count against `BETA_MAX_GLOBAL_TVL_SOL`.
- Symmetric anonymity gate enforced — exit deposits don't move forward if the destination pool would have an anonymity set < 20 at withdraw time.

---

## 5. Cross-feature UI/UX spec

### 5.1 Component inventory

| Component | Used by | Status |
| --- | --- | --- |
| `BetaWarningBanner.tsx` | All pages | ✅ exists |
| `TosAckModal.tsx` | All authenticated flows | ⚠ extend with server-side ack |
| `StealthExplainerModal.tsx` | First-time deposit | ❌ build Day 3 |
| `StealthSeedExportModal.tsx` | User-initiated | ❌ build Day 4 |
| `PrivateDepositModal.tsx` | Feature 1 | ⚠ extend |
| `PrivateClaimModal.tsx` | Feature 2 | ❌ build Days 7–8 |
| `PrivateExitModal.tsx` | Feature 3 | ❌ build Days 6–9 |
| `DenominationSelector.tsx` | Feature 1, exit calc | ❌ build Day 1 |
| `AnonymityBadge.tsx` | Selector, position card | ❌ build Day 2 |
| `PrivacyDelayTimer.tsx` | All progress modals | ❌ build Day 6 |
| `ProgressStepper.tsx` | All progress modals | ❌ build Day 6 |
| `AccruedFeesPanel.tsx` | Position detail | ❌ build Day 7 |
| `PrivacyVsDirectClaimToggle.tsx` | Claim modal | ❌ build Day 7 |
| `PrivacyVsDirectExitToggle.tsx` | Exit modal | ❌ build Day 6 |
| `DustWarningPanel.tsx` | Exit modal | ❌ build Day 8 |
| `RecoveryStateCard.tsx` | All failure paths | ❌ build Day 9 |
| `NetworkMismatchBanner.tsx` | Global | ✅ exists (P1-35) |

### 5.2 Pages and their responsibilities

| Page | Path | Responsibility |
| --- | --- | --- |
| Landing | `/` | Marketing + ToS link + waitlist sign-up |
| Pools | `/app/pools` | Browse DLMM pools with anonymity-set indicators |
| Pool detail | `/app/pools/:address` | Pool stats + add-liquidity CTA |
| Portfolio | `/app/portfolio` | List of user's positions joined to main wallet via `Position.walletAddress` |
| Position detail | `/app/positions/:id` | Single position; claim and exit CTAs; activity log |
| Beta status | `/app/status` | Status page link or embed; cohort-specific info |
| Legal | `/legal/{tos,privacy,risk}` | Lawyer-finalized documents |

### 5.3 State management

- TanStack Query for all server state (already used). Cache key per route.
- Position state polling: poll `GET /positions/:id` every 5 s when state is non-terminal; stop when terminal.
- Mixer pool state polling: poll `GET /mixer/pools` every 30 s on pool-listing pages.
- Wallet state via `SolanaProvider`.
- Stealth wallet state via `useStealth()` hook (re-derives on demand from cached signature).

### 5.4 Loading / empty / error states

Required for every page:

- **Skeleton loader** during initial fetch (P1-37).
- **Empty state** with action — e.g., portfolio empty: "No positions yet — browse pools."
- **Error boundary** at page level — catch React errors, report to Sentry, show "Something went wrong" + retry button (P1-37).
- **Network mismatch banner** at top — already exists (`networkStatus.ts`).
- **Mixer pool paused banner** when any of the three pools is paused — pulled from `/health` and `/mixer/pools`.
- **Beta cohort indicator** — small badge "Beta cohort 1" in nav; click reveals current TVL caps.

### 5.5 Accessibility

- All modals trap focus and restore on close.
- Color is never the sole signal — anonymity badges include text label.
- All progress steps have ARIA live region for screen readers.
- Wallet connect, ToS sign, deposit confirmation reachable via keyboard alone.
- WCAG AA color contrast on all interactive surfaces.

### 5.6 Mobile considerations

Beta cohort is desktop-first (testers will likely be technical users on laptops). Mobile is post-MVP.

For MVP:
- Pages must be readable on a 1024px viewport (laptop minimum).
- Modals must fit without horizontal scroll.
- No touch-only interactions.
- Below 768px viewport: show "Best experienced on desktop during beta" banner; flows still functional.

### 5.7 Performance

- ZK proof generation in browser — acceptable wait up to 30 s. If longer, add progress bar + worker thread (post-MVP).
- All API responses cached at client per TanStack defaults (60 s for pools, 5 s for position state).
- Bundle size budget: < 500 KB initial JS (gzipped). Lazy-load heavy deps (snarkjs, three.js for landing animations).

### 5.8 What must NOT happen in UI

- No mock data in production bundle (P1-39 — CI guard).
- No `console.log` of any wallet pubkey or signature.
- No localStorage of any private key, seed, or signature.
- No hidden direct-exit path that bypasses warnings.
- No silent fallback to direct exit if private exit fails — always surface the failure and let the user choose.

---

## 6. Verification matrix

Maps each feature to its test coverage. Green when all rows are covered.

| Feature | Unit | Integration | E2E (devnet) | Failure-mode | Privacy assertion |
| --- | --- | --- | --- | --- | --- |
| Private add-liquidity | Day 5 | Day 5 | Day 5 | Day 5 | Day 10 |
| Private claim fees | Day 8 | Day 8 | Day 10 | Day 10 | Day 10 |
| Private withdraw | Day 8 | Day 9 | Day 10 | Day 10 | Day 10 |

"Privacy assertion" = Solana Explorer graph traversal confirming no direct stealth → main transfer outside the mixer path.

---

## 7. Out of scope for MVP

| Item | Why deferred | When |
| --- | --- | --- |
| Partial close (close part of a position, leave the rest) | Doubles state-machine complexity; can wait | Post-MVP |
| Auto-claim when fees exceed threshold | Adds background scheduling; not core to privacy | Post-MVP |
| Mobile-first UX | Desktop-first for beta cohort | Post-MVP |
| Aggregating multiple positions' claims into one mixer entry | Coordination complexity | Post-MVP |
| User-submitted withdraws (no relayer, gas paid by user) | Privacy boost not safety-critical for MVP | Post-MVP |
| Per-token mixer pools (e.g., USDC pool) | Three SOL-denomination pools cover the MVP TVL band | Post-MVP |
| Cross-pool aggregator routing for low-liquidity pairs | Out-of-scope — supports DLMM only | Post-MVP |
| MEV protection beyond slippage caps | Slippage is the MVP defense | Post-MVP |
| Indexer reorg handling on `finalized` | Accepted risk under TVL caps for beta (P3-NEW-C) | First post-beta sprint |
| OFAC / sanctions screening at deposit-side | Geographic restriction in ToS for MVP | Before public launch (P2-33) |

---

## 8. Mapping to master plan days

For each item below, the day reference is in `MVP_LAUNCH_PLAN.md`.

### Week 1 — Feature 1 foundation
- Day 1: multi-pool init, DAMM delete, denomination selector skeleton.
- Day 2: anonymity-set gate, `/mixer/pools`, frontend Sentry, denomination selector live.
- Day 3: error boundaries, stealth explainer modal.
- Day 4: stealth seed export, server-side ToS ack, per-wallet rate limit.
- Day 5: Week 1 verification gate (Feature 1 fully working on devnet).

### Week 2 — Features 2 + 3 build
- Day 6: state machine extensions (claim + exit), `exit_recipient = stealth` enforced, `PrivateExitModal` scaffold.
- Day 7: heterogeneous swap helper, claim orchestration, exit modal wiring.
- Day 8: dust handling, slippage controls, anonymity-symmetric exit policy, claim modal.
- Day 9: monitoring wiring, edge cases (KMS unavailable, partial exit recovery).
- Day 10: Week 2 verification gate (all three features pass devnet E2E).

### Week 3 — Verification + ceremony + deploy
- Days 11–12: ceremony, VK rebuild, CPI substitution tests, sysvar identity, mainnet-cloned fixtures.
- Day 13: dress rehearsal + tabletop.
- Day 14: mainnet deploy.
- Day 15: beta open.

---

## 9. The single most important thing

The privacy is not in the code. The privacy is in the policy. Every code path must default to private; every override must be loud.

This means:
- Add liquidity → private deposit is the only deposit flow. There is no "direct deposit." (Already true today.)
- Claim fees → "Private claim" is the default CTA. "Direct claim" is not surfaced as a primary action; if shown at all, it's behind a disclosure with a clear warning.
- Close position → "Private exit" is the default CTA. "Direct close" is small text with a one-line warning, requires a second confirmation, and posts to a non-default endpoint.
- `exit_recipient` is always the stealth, not the main wallet, regardless of what the user "wants." If a user wants a direct claim, the orchestration runs claim → stealth → direct transfer to main as the final step, *not* a different `exit_recipient`. This way the program-level invariant ("`exit_recipient = stealth`") never has to flip per-user, which is a class of bug we don't want to invite.

If this single design rule is honored, the marketing claim "copy-trade bots see nothing" holds for every user by default. If we let `exit_recipient` vary per user or per call, the privacy becomes an opt-in feature, and most users in practice will not opt in — which is the failure mode every privacy product before us has hit.
