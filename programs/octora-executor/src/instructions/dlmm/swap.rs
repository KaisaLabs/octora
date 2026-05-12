//! `swap_via_dlmm` — pause-gated, slippage-enforced wrapper around Meteora
//! DLMM `swap`. The stealth wallet swaps SOL ↔ target token on a chosen
//! lb_pair *before* the LP step, so the executor can support any DLMM pair
//! without a per-token mixer pool.
//!
//! Trust model:
//! - The only signer required by DLMM `swap` is the `user` (= stealth). The
//!   stealth's signature on the outer ix already authorizes that role; no
//!   PDA signing is needed, so we use plain `invoke` (no `signer_seeds`)
//!   and skip CPI re-pinning.
//! - Defense in depth: we pre/post read `user_token_out.amount` and
//!   reject if `(post − pre) < min_amount_out`, independent of whatever
//!   slippage check DLMM does internally.
//! - Same-pool reject (swap pool == LP target pool) lives in the backend
//!   orchestrator — this ix only sees one pool at a time, so it cannot
//!   enforce that constraint at the program layer in Phase 1.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::CONFIG_SEED;
use crate::cpi::dlmm::{
    build_dlmm_ix, invoke_dlmm, require_dlmm_event_authority, require_dlmm_program,
};
use crate::cpi::{read_token_account_amount, require_spl_token_program, require_token_account_owner};
use crate::errors::ExecutorError;
use crate::state::Config;

// ── Remaining-account layout (mirrors DLMM `swap` IDL) ──
//
//  0  lb_pair                    (mut)
//  1  bin_array_bitmap_extension (mut, may be DLMM program id if absent)
//  2  reserve_x                  (mut)
//  3  reserve_y                  (mut)
//  4  user_token_in              (mut, owned by stealth)
//  5  user_token_out             (mut, owned by stealth) — slippage-checked
//  6  token_x_mint
//  7  token_y_mint
//  8  oracle                     (mut)
//  9  host_fee_in                (mut, may be DLMM program id if absent)
// 10  user                       (signer = stealth)
// 11  token_x_program
// 12  token_y_program
// 13  event_authority
// 14  dlmm_program
// 15+ bin_arrays                 (mut, ≥1)
//
// Minimum: 15 fixed + 1 bin array = 16.
const MIN_REMAINING: usize = 16;

const IDX_LB_PAIR: usize = 0;
const IDX_USER_TOKEN_IN: usize = 4;
const IDX_USER_TOKEN_OUT: usize = 5;
const IDX_TOKEN_X_MINT: usize = 6;
const IDX_TOKEN_Y_MINT: usize = 7;
const IDX_USER: usize = 10;
const IDX_TOKEN_X_PROGRAM: usize = 11;
const IDX_TOKEN_Y_PROGRAM: usize = 12;
const IDX_EVENT_AUTHORITY: usize = 13;
const IDX_DLMM_PROGRAM: usize = 14;

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

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DlmmSwap<'info>>,
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    require!(
        amount_in > 0 && min_amount_out > 0,
        ExecutorError::ArgOutOfRange
    );

    require_dlmm_program(&ctx.accounts.dlmm_program)?;

    let remaining = ctx.remaining_accounts;
    require!(
        remaining.len() >= MIN_REMAINING,
        ExecutorError::AccountsTooShort
    );

    // ── Per-account validations ─────────────────────────────────────────────
    let stealth_key = ctx.accounts.stealth.key();

    // lb_pair forwarded must match the one in the account struct (which the
    // backend uses to derive seeds on its side and is what's stored client-
    // side as the swap source pool).
    require_keys_eq!(
        remaining[IDX_LB_PAIR].key(),
        ctx.accounts.lb_pair.key(),
        ExecutorError::LbPairMismatch
    );

    // Both user token accounts must be owned by the stealth wallet — prevents
    // routing of tokens through accounts owned by a third party.
    require_token_account_owner(&remaining[IDX_USER_TOKEN_IN], &stealth_key)?;
    require_token_account_owner(&remaining[IDX_USER_TOKEN_OUT], &stealth_key)?;

    // Reject a circular swap where in and out point at the same account.
    // DLMM's own validation may catch this, but verifying here keeps the
    // contract self-defending: passing the same account twice could cause
    // confusing balance-delta accounting on the post-swap slippage check
    // (pre and post would both observe the input-side mutation).
    require_keys_neq!(
        remaining[IDX_USER_TOKEN_IN].key(),
        remaining[IDX_USER_TOKEN_OUT].key(),
        ExecutorError::TokenMintMismatch
    );

    // The DLMM `user` account in the inner ix MUST be the same stealth pubkey
    // that signed our outer ix. Without this, an attacker could pass a
    // different signer in the remaining_accounts list and let DLMM treat
    // *that* account as the swap user.
    require_keys_eq!(
        remaining[IDX_USER].key(),
        stealth_key,
        ExecutorError::StealthMismatch
    );
    require!(
        remaining[IDX_USER].is_signer,
        ExecutorError::StealthMismatch
    );

    // SPL Token / Token-2022 only.
    require_spl_token_program(&remaining[IDX_TOKEN_X_PROGRAM])?;
    require_spl_token_program(&remaining[IDX_TOKEN_Y_PROGRAM])?;

    // Each user token account's mint must be one of the lb_pair's tokens.
    // We don't know swap direction here — DLMM derives that from which
    // (token_in, token_out) you pass — but we *do* know the union must
    // match {token_x_mint, token_y_mint}.
    let mint_x = remaining[IDX_TOKEN_X_MINT].key();
    let mint_y = remaining[IDX_TOKEN_Y_MINT].key();
    let in_mint = read_token_account_mint(&remaining[IDX_USER_TOKEN_IN])?;
    let out_mint = read_token_account_mint(&remaining[IDX_USER_TOKEN_OUT])?;
    require!(
        (in_mint == mint_x && out_mint == mint_y) || (in_mint == mint_y && out_mint == mint_x),
        ExecutorError::TokenMintMismatch
    );

    require_dlmm_event_authority(&remaining[IDX_EVENT_AUTHORITY])?;
    require_dlmm_program(&remaining[IDX_DLMM_PROGRAM])?;

    // ── Pre-balance for slippage enforcement ────────────────────────────────
    let pre_out = read_token_account_amount(&remaining[IDX_USER_TOKEN_OUT])?;

    // ── Build inner DLMM `swap` ix ──────────────────────────────────────────
    // Args: amount_in: u64, min_amount_out: u64
    let mut args = Vec::with_capacity(16);
    args.extend_from_slice(&amount_in.to_le_bytes());
    args.extend_from_slice(&min_amount_out.to_le_bytes());

    // is_signer / is_writable are hardcoded per slot rather than copied
    // from `ai`. Trusting the caller's flags would let a client flip a
    // read-only sysvar to writable (or vice versa) and downstream rely
    // on whatever DLMM does with that — we don't grant that latitude.
    //
    // Layout matches MIN_REMAINING + variable bin-array tail. Bin arrays
    // (indices >= MIN_REMAINING - 1) are always mutable.
    let metas: Vec<AccountMeta> = remaining
        .iter()
        .enumerate()
        .map(|(i, ai)| {
            let (is_signer, is_writable) = match i {
                IDX_USER => (true, true),
                IDX_LB_PAIR => (false, true),
                1 => (false, true),                // bin_array_bitmap_extension
                2 | 3 => (false, true),            // reserve_x, reserve_y
                IDX_USER_TOKEN_IN | IDX_USER_TOKEN_OUT => (false, true),
                IDX_TOKEN_X_MINT | IDX_TOKEN_Y_MINT => (false, false),
                8 => (false, true),                // oracle
                9 => (false, true),                // host_fee_in
                IDX_TOKEN_X_PROGRAM | IDX_TOKEN_Y_PROGRAM => (false, false),
                IDX_EVENT_AUTHORITY => (false, false),
                IDX_DLMM_PROGRAM => (false, false),
                _ => (false, true),                // bin_arrays — always mut
            };
            AccountMeta {
                pubkey: ai.key(),
                is_signer,
                is_writable,
            }
        })
        .collect();

    let ix = build_dlmm_ix("swap", metas, args);

    // No PDA signers: stealth signs the outer tx, that signature satisfies
    // DLMM's `user` requirement on the inner ix.
    invoke_dlmm(&ix, remaining)?;

    // ── Post-balance + slippage enforcement ─────────────────────────────────
    let post_out = read_token_account_amount(&remaining[IDX_USER_TOKEN_OUT])?;
    let received = post_out
        .checked_sub(pre_out)
        .ok_or(ExecutorError::ArgOutOfRange)?;
    require!(
        received >= min_amount_out,
        ExecutorError::SwapSlippageExceeded
    );

    msg!(
        "dlmm_swap: stealth={} lb_pair={} amount_in={} min_out={} received={}",
        stealth_key,
        ctx.accounts.lb_pair.key(),
        amount_in,
        min_amount_out,
        received,
    );

    Ok(())
}

/// Read the `mint` field (bytes 0..32) of an SPL Token / Token-2022 account.
fn read_token_account_mint(ai: &AccountInfo) -> Result<Pubkey> {
    let data = ai.try_borrow_data()?;
    require!(data.len() >= 165, ExecutorError::InvalidTokenAccount);
    let mint_bytes: [u8; 32] = data[0..32].try_into().unwrap();
    Ok(Pubkey::new_from_array(mint_bytes))
}
