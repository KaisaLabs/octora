# Plan 1 — Program: `swap_via_dlmm` instruction

**Layer:** Anchor program (`programs/octora-executor`)
**Effort:** 3–5 engineer-days
**Depends on:** P0-NEW-A (DAMM modules deleted)
**Blocks:** Plan 2 (backend orchestration)

## Goal

Add a single instruction `swap_via_dlmm` to the executor program that lets the stealth wallet swap SOL ↔ target token via a Meteora DLMM pool. Same trust surface as `add_liquidity` — same PoolAuthority PDA, same pause gate, same signer constraints, same CPI re-pinning pattern.

## Files

### New
- `programs/octora-executor/src/instructions/dlmm/swap.rs`
- `programs/octora-executor/src/cpi/dlmm_swap.rs` (CPI wrapper)
- `tests/octora-executor-dlmm-swap.ts`
- `tests/octora-executor-dlmm-swap-negative.ts`

### Modify
- `programs/octora-executor/src/lib.rs` — register `swap_via_dlmm` handler
- `programs/octora-executor/src/instructions/dlmm/mod.rs` — `pub mod swap;`
- `programs/octora-executor/src/error.rs` — add `SwapSourceEqualsTarget`, `SwapSlippageExceeded`
- `programs/octora-executor/src/cpi/mod.rs` — re-export swap helper

## Account struct (target)

```rust
#[derive(Accounts)]
pub struct SwapViaDlmm<'info> {
    #[account(seeds = [CONFIG_SEED], bump, constraint = !config.paused @ ExecutorError::Paused)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub stealth: Signer<'info>,

    /// CHECK: validated against allowlisted DLMM program
    #[account(address = DLMM_PROGRAM_ID @ ExecutorError::InvalidProgram)]
    pub dlmm_program: UncheckedAccount<'info>,

    /// CHECK: lb_pair owned by dlmm_program; key checked downstream
    #[account(mut, owner = DLMM_PROGRAM_ID @ ExecutorError::InvalidPool)]
    pub lb_pair: UncheckedAccount<'info>,

    /// CHECK: pool authority PDA — re-pinned in CPI signer list
    #[account(seeds = [POOL_AUTHORITY_SEED, lb_pair.key().as_ref()], bump)]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,

    #[account(mut, token::authority = stealth)]
    pub user_token_in: Account<'info, TokenAccount>,
    #[account(mut, token::authority = stealth)]
    pub user_token_out: Account<'info, TokenAccount>,

    pub token_x_mint: Account<'info, Mint>,
    pub token_y_mint: Account<'info, Mint>,

    /// CHECK: bin arrays for the swap range — passed through to DLMM
    #[account(mut)]
    pub bin_array_0: UncheckedAccount<'info>,
    #[account(mut)]
    pub bin_array_1: UncheckedAccount<'info>,
    #[account(mut)]
    pub bin_array_2: UncheckedAccount<'info>,

    /// CHECK: oracle for the lb_pair (DLMM swap may consult)
    #[account(mut)]
    pub oracle: UncheckedAccount<'info>,

    pub event_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}
```

## Handler signature

```rust
pub fn handler(
    ctx: Context<SwapViaDlmm>,
    amount_in: u64,
    min_amount_out: u64,
    swap_for_y: bool, // direction
) -> Result<()> {
    // 1. Sanity: amount_in > 0
    // 2. Pre-balance read on user_token_out
    // 3. Build CPI account list with PoolAuthority PDA re-pinned
    // 4. invoke_signed DLMM swap
    // 5. Post-balance read; assert (post - pre) >= min_amount_out
    // 6. Emit event
}
```

## Tasks (in order)

1. **Scaffolding** (½ day)
   - Create `swap.rs` and `dlmm_swap.rs`. Wire `lib.rs` and `instructions/dlmm/mod.rs`.
   - Confirm `anchor build` succeeds with empty handler.

2. **CPI wrapper** (1 day)
   - Implement `cpi::dlmm_swap::cpi_swap(...)` that builds the DLMM swap discriminator + serialized args.
   - Reference: `meteora-invent/` SDK for DLMM swap account ordering. Confirm against on-chain DLMM IDL.
   - Ensure PoolAuthority PDA `to_account_info()` is in the infos vector AND in the signer-seeds list (Fix #4 pattern from `add_liquidity.rs:114–118`).

3. **Handler logic** (1 day)
   - Pre/post balance check on `user_token_out` for slippage enforcement (don't trust DLMM's internal `min_out` alone).
   - Custom error `SwapSlippageExceeded` if `(post - pre) < min_amount_out`.
   - Emit `SwapExecuted { stealth, lb_pair, amount_in, amount_out, swap_for_y }`.

4. **Negative tests** (1 day)
   - Missing signer on `stealth` → fails.
   - `config.paused = true` → fails with `Paused`.
   - `min_amount_out` too aggressive → fails with `SwapSlippageExceeded`.
   - Wrong `dlmm_program` key → fails with `InvalidProgram`.
   - Wrong `pool_authority` (not derived from `lb_pair`) → fails.
   - Substituted `lb_pair` (different from re-pinned PDA) → fails (CPI re-pin defense).
   - Wrong `user_token_out` mint (not matching swap direction) → fails (Anchor token::mint constraint).

5. **Positive test** (½ day)
   - Surfpool fixture: pre-loaded SOL/USDC DLMM pool. Stealth deposits 1 SOL, swap to USDC, verify USDC balance increases by ≥ `min_amount_out`, SOL balance decreases by `amount_in`.

6. **IDL & Cargo** (¼ day)
   - `anchor build` → confirm IDL emits `swapViaDlmm` with the expected accounts.
   - `cargo clippy --all-targets -- -D warnings` clean.

7. **Audit notes** (¼ day)
   - Add to `runbooks/PRODUCTION_READINESS.md` an entry: "swap_via_dlmm CPI surface — covered by signer re-pinning, mint validation, balance-delta slippage, paused gate."

## Same-pool enforcement (program side)

The same-pool guard belongs primarily in the backend (Plan 2) because in a single tx the executor only sees the swap step or the LP step, not both. **However**, if you batch swap + LP in one tx (recommended for atomicity), add an Anchor constraint:

```rust
// In a combined `swap_then_lp` instruction (optional Phase 2):
require!(
    ctx.accounts.swap_lb_pair.key() != ctx.accounts.lp_lb_pair.key(),
    ExecutorError::SwapSourceEqualsTarget
);
```

For Phase 1 (separate txs), the program does not enforce this — backend does.

## Acceptance criteria

- [ ] `anchor test` passes locally (positive + 6 negative cases).
- [ ] `anchor build` IDL diff reviewed; only `swapViaDlmm` added; no DAMM artifacts.
- [ ] `cargo clippy` clean.
- [ ] No new `UncheckedAccount` without an Anchor constraint or downstream key validation.
- [ ] PoolAuthority re-pin confirmed by inspecting CPI account order.

## Risks

| Risk | Mitigation |
| --- | --- |
| DLMM swap account ordering changes between SDK versions | Pin Meteora SDK version in `Cargo.toml`; add a regression test that fails on unexpected discriminator |
| Slippage check fooled by token-2022 transfer hooks | Use `user_token_out` *post-mint-fee* balance via direct Token-2022 read if mint has hook |
| Bin array selection incorrect for active swap range | Backend computes bin arrays; document in Plan 2 |
| PoolAuthority PDA seed change in upstream DLMM | `POOL_AUTHORITY_SEED` is hardcoded — pin via constants test |

## Out of scope

- Multi-hop swaps
- Cross-program swap (Raydium, Orca, etc.)
- Token-2022 transfer-hook plumbing beyond what existing `add_liquidity` supports
- Jupiter integration

## Definition of done

- All tests green in CI (after Plan 4 wires `anchor test` into CI).
- Reviewed by a second engineer focusing on CPI re-pinning + slippage check correctness.
- Devnet deploy successful; one manual swap executed and verified by tx inspection.
