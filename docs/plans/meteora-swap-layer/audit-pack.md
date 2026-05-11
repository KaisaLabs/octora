# Meteora Swap Layer — Audit Pack

**Plan:** `docs/plans/meteora-swap-layer/`
**Status:** Plans 1–3 implemented; Plan 4 in progress.
**Audience:** Internal review (≥2 engineers) and/or external auditor (Zellic / OtterSec / Trail of Bits / Cure53) per P2-54.

This document is the focused diff-review surface for the swap layer. It exists so an auditor can review *only* the swap-related changes without re-reading the rest of the executor program. Read top to bottom; every CPI surface, balance check, and state transition is listed once.

---

## 1. Threat model summary

The swap layer adds an on-chain Meteora DLMM swap step between the privacy-funded stealth wallet and the LP `add_liquidity` call. Its purpose is to support LP into pools whose quote asset is not SOL (e.g. memecoin/USDC, JUP/USDC) without breaking the mixer's SOL-only anonymity set.

**Threat model in scope for this audit:**
1. **Self-front-running.** The swap is on a *different* pool than the LP target. Same-pool swap → LP would consume the bins it then re-fills, eating spread + impact. Defended by client + service rejection (no on-chain enforcement in Phase 1; see §6).
2. **Slippage manipulation.** A malicious DLMM upgrade (or an unexpected price move) could deliver fewer tokens than the swap quote promised. Defended by a balance-delta post-check independent of DLMM's internal `min_out`.
3. **Account substitution.** Caller passes a doctored token account, mint, or DLMM program account hoping the executor forwards it without checking. Defended by per-account validation in `swap.rs:91–143`.
4. **Pause bypass.** Caller invokes the swap during an emergency halt. Defended by `Config.paused` constraint.
5. **Stealth-wallet hijack.** Caller signs the outer ix as someone else and steals the swapped tokens. Defended by Anchor's `Signer<'info>` on `stealth` plus an explicit `remaining[IDX_USER] == stealth.key()` check.

**Out of scope for this audit (acknowledged risks):**
- Cross-DEX routing / Jupiter integration — explicitly deferred (no Jupiter in the privacy boundary).
- DAMM modules — being deleted under P0-NEW-A; CI now greps to prevent regressions.
- Token-2022 hooks — `// MAINNET_BLOCKER` markers exist in the existing executor; same posture applies to swap.
- Atomic swap+LP composition (Phase 2 optimization).

---

## 2. Files changed (program)

| File | Lines | Purpose |
| --- | --- | --- |
| `programs/octora-executor/src/instructions/dlmm/swap.rs` | new, 199 | `swap_via_dlmm` ix handler + account struct |
| `programs/octora-executor/src/instructions/dlmm/mod.rs` | +2 / +2 | Register module + re-export |
| `programs/octora-executor/src/cpi/dlmm.rs` | +9 | `invoke_dlmm` (non-PDA-signed CPI) |
| `programs/octora-executor/src/cpi/mod.rs` | +14 | `invoke_ix` + `read_token_account_amount` |
| `programs/octora-executor/src/errors.rs` | +6 | `SwapSlippageExceeded` (6025), `SwapSourceEqualsTarget` (6026) |
| `programs/octora-executor/src/lib.rs` | +12 | Register `dlmm_swap` handler |

No modifications to existing instruction files. The swap surface is strictly additive.

### IDL signature

```json
{
  "name": "dlmm_swap",
  "discriminator": [16, 217, 101, 223, 4, 0, 193, 110],
  "accounts": [
    {"name": "stealth",      "writable": true, "signer": true},
    {"name": "dlmm_program"},
    {"name": "lb_pair"},
    {"name": "config",       "pda": {"seeds": [{"kind": "const", "value": [99,111,110,102,105,103]}]}}
  ],
  "args": [
    {"name": "amount_in",       "type": "u64"},
    {"name": "min_amount_out",  "type": "u64"}
  ]
}
```

---

## 3. CPI surface — `swap_via_dlmm`

### Account constraints (Anchor-level)

```rust
#[derive(Accounts)]
pub struct DlmmSwap<'info> {
    #[account(mut)]
    pub stealth: Signer<'info>,
    /// CHECK: validated in handler against canonical DLMM program ID.
    pub dlmm_program: UncheckedAccount<'info>,
    /// CHECK: validated in handler against `remaining_accounts[IDX_LB_PAIR]`.
    pub lb_pair: UncheckedAccount<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ ExecutorError::Paused,
    )]
    pub config: Account<'info, Config>,
}
```

`Config` constraint = pause gate. Same pattern as every other DLMM ix.

### Handler-level validations (swap.rs:91–143)

| # | Check | Error code | Defense |
| --- | --- | --- | --- |
| 1 | `amount_in > 0` | `ArgOutOfRange` (6012) | rejects no-op submissions |
| 2 | `dlmm_program.key() == DLMM_PROGRAM_ID` | `DlmmProgramMismatch` (6000) | program substitution |
| 3 | `remaining.len() >= 16` | `AccountsTooShort` (6013) | malformed account list |
| 4 | `remaining[IDX_LB_PAIR].key() == ctx.accounts.lb_pair.key()` | `LbPairMismatch` (6003) | lb_pair substitution between outer/inner |
| 5 | `user_token_in.owner == stealth` | `ExitRecipientMismatch` (6006) | route through attacker-owned input ATA |
| 6 | `user_token_out.owner == stealth` | `ExitRecipientMismatch` (6006) | route output to attacker ATA |
| 7 | `remaining[IDX_USER].key() == stealth` | `StealthMismatch` (6005) | DLMM `user` account hijack |
| 8 | `remaining[IDX_USER].is_signer` | `StealthMismatch` (6005) | belt-and-braces on inner signer |
| 9 | `token_x_program ∈ {SPL, Token-2022}` | `InvalidTokenProgram` (6008) | rogue token-program forwarding |
| 10 | `token_y_program ∈ {SPL, Token-2022}` | `InvalidTokenProgram` (6008) | rogue token-program forwarding |
| 11 | `(in_mint, out_mint) ∈ permutations({token_x_mint, token_y_mint})` | `TokenMintMismatch` (6022) | swap into an unrelated token |
| 12 | `event_authority == DLMM event PDA` | `DlmmEventAuthorityMismatch` (6010) | IDL drift detection |
| 13 | `remaining[IDX_DLMM_PROGRAM] == DLMM_PROGRAM_ID` | `DlmmProgramMismatch` (6000) | program list substitution |

### Slippage post-check (swap.rs:148–164)

```rust
let pre_out = read_token_account_amount(&remaining[IDX_USER_TOKEN_OUT])?;
// ... build + invoke DLMM swap ix ...
let post_out = read_token_account_amount(&remaining[IDX_USER_TOKEN_OUT])?;
let received = post_out.checked_sub(pre_out).ok_or(ExecutorError::ArgOutOfRange)?;
require!(received >= min_amount_out, ExecutorError::SwapSlippageExceeded);
```

- Reads the user's output ATA balance directly from raw bytes (offset 64..72), bypassing any DLMM SDK parsing. Compatible with both SPL Token and Token-2022 layouts.
- `checked_sub` ensures we don't silently treat a balance *decrease* as success.
- Independent of DLMM's internal `min_out` — even if DLMM accepts the swap, our check rejects the tx if the realised output is below `min_amount_out`.

### CPI invocation

```rust
let metas: Vec<AccountMeta> = remaining.iter().map(...).collect();
let ix = build_dlmm_ix("swap", metas, args);
invoke_dlmm(&ix, remaining)?;  // plain `invoke`, no signer_seeds
```

No PDA signers. The stealth wallet is the only signer required by DLMM's `swap` ix, and it's already a signer on the outer Anchor ix → the inner CPI inherits that signature.

**No CPI re-pinning is needed** — re-pinning is a defense for instructions where a PDA signs as the actor (`add_liquidity`, `init_position`). Swap doesn't have that pattern.

---

## 4. Negative-test coverage matrix

`tests/octora-executor-dlmm-swap-negative.ts` (8 cases) and `tests/octora-executor-dlmm-swap.ts` (positive + slippage):

| Test | Asserts | Defends against |
| --- | --- | --- |
| `rejects amount_in == 0` | `ArgOutOfRange` | empty submission as no-op probe |
| `rejects wrong DLMM program ID` | `DlmmProgramMismatch` | program substitution |
| `rejects lb_pair forwarded != lb_pair in account struct` | `LbPairMismatch` | inner/outer pool mismatch |
| `rejects user_token_in not owned by stealth` | `ExitRecipientMismatch` | route through attacker-owned ATA |
| `rejects user account != stealth signer` | `StealthMismatch` | DLMM `user` substitution |
| `rejects mint mismatch` | `TokenMintMismatch` | swap into unrelated token |
| `rejects non-SPL token program` | `InvalidTokenProgram` | rogue token-program |
| `rejects wrong DLMM event authority` | `DlmmEventAuthorityMismatch` | IDL drift |
| `happy path: swaps X→Y` | balance increases by ≥ `min_amount_out` | end-to-end |
| `rejects when min_amount_out unreachable` | error (DLMM or `SwapSlippageExceeded`) | slippage |

**Not yet covered (suggested for fuzz / external audit):**
- `swap_indexing` race: tx confirmation ↔ recovery worker re-submission (P3).
- Token-2022 with transfer hooks where `post - pre` ≠ realised user balance (currently rejected via the `// MAINNET_BLOCKER` posture).
- Concurrent swap + add_liquidity from different intents on the same stealth wallet (no-op for Phase 1; relevant for Phase 2 atomic composition).

---

## 5. Backend-side defenses (octora-api)

The same-pool reject and source-pool resolution live off-chain. Auditor should read:

| File | Lines | Purpose |
| --- | --- | --- |
| `octora-api/src/modules/executor/swap.service.ts` | new, 200+ | `validateSwapIntent`, `computeMinAmountOut`, slippage cap |
| `octora-api/src/modules/executor/swap-pool-resolver.ts` | new, 78 | `recommendSwapSource`, `listSwapSourceCandidates` |
| `octora-api/src/modules/executor/clients/dlmm-swap.client.ts` | new, 167 | unsigned-tx builder via Anchor IDL |
| `octora-api/src/modules/positions/position.service.ts` | +35 | swap-state threading; cheap same-pool reject |
| `octora-api/src/modules/positions/position.controller.ts` | +14 | per-wallet `BetaAccess.swapEnabled` gate |
| `octora-api/src/common/auth.ts` | +8 | exposes `swapEnabled` flag on the request |

### Rejects (server-side, before any signer is asked)

| Reject | Why | Where |
| --- | --- | --- |
| `swap.sourcePoolAddress === pool` | self-front-running | `position.service.ts:159` (cheap) + `swap.service.ts:117` (full) |
| `targetIsSolQuoted && swap` | unnecessary swap | `swap.service.ts:84` |
| `!targetIsSolQuoted && !swap` | missing swap | `swap.service.ts:96` |
| `!swapEnabled (config) && swap` | feature flag off | `swap.service.ts:106` |
| `!betaAccess.swapEnabled && swap` | per-wallet allowlist off | `position.controller.ts:76` (Plan 4) |
| `swap source pool not in indexer` | unverified pool | `swap.service.ts:138` |
| `swap source pool ≠ SOL-paired` | breaks the privacy invariant | `swap.service.ts:153` |
| `minAmountOut <= 0` | invalid bound | `swap.service.ts:130` |
| `slippageBps > 2000` (UI hard-cap) | sanity bound | `swap.ts:computeMinAmountOut` (mirrored client + server) |

---

## 6. Known limitations (auditor please flag)

1. **Same-pool reject is off-chain only.** A direct `dlmm_swap` invocation that bypasses the position-service path and points at the LP target pool is *not* rejected by the program. Mitigated because: (a) the front-end + backend always go through the service path, (b) the resulting LP entry would be self-defeating economically, (c) Phase 2's atomic `swap_then_lp` ix would enforce it on-chain. Audit recommendation: confirm this risk acceptance.

2. **Bin-array selection is heuristic.** `dlmm-swap.client.ts` picks two bin arrays around the active bin. For swaps that move price across more arrays, the inner DLMM call would fail with its own error. We treat that as graceful degradation (`SwapSlippageExceeded` or DLMM-side error). Audit recommendation: confirm no asymmetric-fee path is exploitable.

3. **`bin_array_bitmap_extension` and `host_fee_in` use the DLMM program id as a sentinel for "absent."** This is the convention DLMM expects, but worth confirming in DLMM's current IDL.

4. **No on-chain enforcement of `EXECUTOR_SWAP_ENABLED`.** The flag lives in the API only. A direct invocation of `dlmm_swap` from a third-party client would succeed regardless of API state. Auditor should verify this is acceptable given (1) — the program is a thin wrapper, not a gating layer.

---

## 7. Suggested fuzz inputs

For an external audit using a fuzzer (e.g. Trident, mollusk-svm):

| Input | Range | Hypothesis |
| --- | --- | --- |
| `amount_in` | `[0, u64::MAX]` | overflow in CPI argument |
| `min_amount_out` | `[0, u64::MAX]` | underflow in slippage check (defended via `checked_sub`) |
| `remaining_accounts.len()` | `[0, 50]` | `AccountsTooShort` covers below-threshold; above should be no-op |
| `remaining[i].is_signer` permutations | each slot toggled | no slot besides `IDX_USER` should require a signer |
| `remaining[i].is_writable` permutations | each slot toggled | mut-mismatch should fail at DLMM, not the executor |
| Re-execution of identical args | n=2 | second tx uses fresh blockhash; no replay-prevention is needed because Solana's tx hash uniqueness handles it |

---

## 8. Severity classification

If the audit surfaces a vulnerability, classify per `runbooks/PRODUCTION_READINESS.md` §0 and:

- **Critical** (fund loss possible) → P0; pause executor (`set_paused`); halt mainnet rollout regardless of phase; bug bounty (P2-53) tier-1 payout.
- **High** (privacy break / DoS) → P1; disable swap layer via `EXECUTOR_SWAP_ENABLED=false`; release patch within 7 days.
- **Medium** (defense-in-depth gap) → P2; queue for next release window; document in this audit pack.
- **Informational** (style / lint) → P3; backlog.

---

## 9. Reviewer checklist

- [ ] Confirm IDL discriminator is correct for "swap" inner ix.
- [ ] Confirm `read_token_account_amount` correctly handles Token-2022 base layout.
- [ ] Confirm `checked_sub` covers every realistic underflow path.
- [ ] Confirm `Config.paused` constraint fires for every state-mutating swap path.
- [ ] Confirm CI's DAMM-grep guard passes with no exceptions in `programs/octora-executor/src/`.
- [ ] Confirm Plan 4 Prisma migration `20260510140000_betaaccess_swap_enabled` applies cleanly to a copy of mainnet's beta DB.
- [ ] Confirm `EXECUTOR_SWAP_ENABLED=false` (mainnet default at Phase D) blocks every swap-related code path end-to-end.

---

## 10. Sign-off

| Role | Reviewer | Date | Status |
| --- | --- | --- | --- |
| Internal · Solana | _TBD_ | _TBD_ | _pending_ |
| Internal · Backend | _TBD_ | _TBD_ | _pending_ |
| External · Audit firm | _TBD_ | _TBD_ | _pending_ |

Block on this table before flipping `EXECUTOR_SWAP_ENABLED=true` on mainnet.
