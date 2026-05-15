use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::{CONFIG_SEED, POOL_AUTHORITY_SEED};
use crate::cpi::dlmm::*;
use crate::cpi::{
    require_spl_token_program, require_token_account_mint, require_token_account_owner,
};
use crate::errors::ExecutorError;
use crate::state::{Config, PoolAuthority, PoolRef};

#[derive(Accounts)]
pub struct DlmmWithdrawClose<'info> {
    #[account(mut)]
    pub stealth: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), lb_pair.key().as_ref()],
        bump = pool_authority.bump,
        constraint = pool_authority.stealth_pubkey == stealth.key()
            @ ExecutorError::StealthMismatch,
        close = stealth,
    )]
    pub pool_authority: Account<'info, PoolAuthority>,

    /// CHECK: validated in handler against stored PoolAuthority lb_pair.
    pub lb_pair: UncheckedAccount<'info>,

    /// CHECK: validated in handler against canonical DLMM program ID.
    pub dlmm_program: UncheckedAccount<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ ExecutorError::Paused,
    )]
    pub config: Account<'info, Config>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DlmmWithdrawClose<'info>>,
    from_bin_id: i32,
    to_bin_id: i32,
    bps_to_remove: u16,
    remaining_accounts_info: Vec<u8>,
) -> Result<()> {
    require!(from_bin_id <= to_bin_id, ExecutorError::ArgOutOfRange);
    require!(
        bps_to_remove > 0 && bps_to_remove <= 10_000,
        ExecutorError::ArgOutOfRange
    );
    require_dlmm_program(&ctx.accounts.dlmm_program)?;

    let pa = &ctx.accounts.pool_authority;
    let remaining = ctx.remaining_accounts;

    // v2 layout:
    //   0 position, 1 lb_pair, 2 bin_array_bitmap_extension (sentinel),
    //   3 user_token_x, 4 user_token_y, 5 reserve_x, 6 reserve_y,
    //   7 token_x_mint, 8 token_y_mint, 9 sender (PA — re-pinned),
    //   10 token_x_program, 11 token_y_program, 12 memo_program,
    //   13 event_authority, 14 program,
    //   15 rent_receiver (= exit_recipient — caller-supplied; second CPI
    //      to close_position2 reads it from this slot).
    //   tail: transfer-hook accounts (described by `remaining_accounts_info`)
    //         followed by bin_array_lower, bin_array_upper.
    //
    // Minimum total = 15 v2 fixed slots + 1 rent_receiver + 2 bin arrays = 18.
    require!(remaining.len() >= 18, ExecutorError::AccountsTooShort);

    let PoolRef::Dlmm { lb_pair, position } = &pa.pool_ref;
    let (stored_lb_pair, stored_position) = (*lb_pair, *position);

    require_keys_eq!(
        remaining[0].key(),
        stored_position,
        ExecutorError::PositionMismatch
    );
    require_keys_eq!(
        remaining[1].key(),
        stored_lb_pair,
        ExecutorError::LbPairMismatch
    );
    require_token_account_owner(&remaining[3], &pa.exit_recipient)?;
    require_token_account_owner(&remaining[4], &pa.exit_recipient)?;
    require_token_account_mint(&remaining[3], &remaining[10], &remaining[7].key())?;
    require_token_account_mint(&remaining[4], &remaining[11], &remaining[8].key())?;
    require_spl_token_program(&remaining[10])?;
    require_spl_token_program(&remaining[11])?;
    require_dlmm_event_authority(&remaining[13])?;
    require_dlmm_program(&remaining[14])?;
    require_keys_eq!(
        remaining[15].key(),
        pa.exit_recipient,
        ExecutorError::ExitRecipientMismatch
    );
    require_keys_neq!(
        remaining[15].key(),
        remaining[0].key(),
        ExecutorError::PositionMismatch
    );
    require_keys_neq!(
        remaining[15].key(),
        remaining[1].key(),
        ExecutorError::LbPairMismatch
    );
    require_keys_eq!(
        ctx.accounts.lb_pair.key(),
        stored_lb_pair,
        ExecutorError::LbPairMismatch
    );

    let pa_key = pa.key();
    let stealth_key = ctx.accounts.stealth.key();
    let bump = pa.bump;
    let signer_seeds: &[&[u8]] = &[
        POOL_AUTHORITY_SEED,
        stealth_key.as_ref(),
        stored_lb_pair.as_ref(),
        &[bump],
    ];

    let build_metas = |indices: &[usize], signer_idx: usize| -> Vec<AccountMeta> {
        indices
            .iter()
            .map(|&i| {
                let ai = &remaining[i];
                if i == signer_idx {
                    AccountMeta {
                        pubkey: pa_key,
                        is_signer: true,
                        is_writable: ai.is_writable,
                    }
                } else {
                    AccountMeta {
                        pubkey: ai.key(),
                        is_signer: ai.is_signer,
                        is_writable: ai.is_writable,
                    }
                }
            })
            .collect()
    };

    let pa_info = ctx.accounts.pool_authority.to_account_info();

    // CPI 1: remove_liquidity_by_range2. Pass v2 fixed slots 0..=14 plus
    // every remaining account from 16..end (transfer hooks + bin arrays).
    // Skip 15 (rent_receiver) — that account is for close_position2.
    let mut remove_indices: Vec<usize> = (0..=14).collect();
    remove_indices.extend(16..remaining.len());
    let remove_metas = build_metas(&remove_indices, 9);
    let mut remove_args =
        Vec::with_capacity(4 + 4 + 2 + remaining_accounts_info.len());
    remove_args.extend_from_slice(&from_bin_id.to_le_bytes());
    remove_args.extend_from_slice(&to_bin_id.to_le_bytes());
    remove_args.extend_from_slice(&bps_to_remove.to_le_bytes());
    remove_args.extend_from_slice(&remaining_accounts_info);
    let remove_ix = build_dlmm_ix("remove_liquidity_by_range2", remove_metas, remove_args);

    let mut remove_infos: Vec<AccountInfo> = remaining
        .iter()
        .enumerate()
        .filter_map(|(i, ai)| {
            if i == 15 {
                None
            } else {
                Some(ai.clone())
            }
        })
        .collect();
    // After filtering out slot 15, sender (was at 9) keeps its index.
    remove_infos[9] = pa_info.clone();
    invoke_dlmm_signed(&remove_ix, &remove_infos, &[signer_seeds])?;

    // CPI 2: close_position2 — position, sender (PA), rent_receiver,
    // event_authority, program. Note close_position2 (v2) drops the
    // bin_array_lower/upper slots that close_position (v1) required.
    let close_indices = [0usize, 9, 15, 13, 14];
    let close_metas = build_metas(&close_indices, 9);
    let close_ix = build_dlmm_ix("close_position2", close_metas, Vec::new());

    let mut close_infos: Vec<AccountInfo> = remaining.to_vec();
    close_infos[9] = pa_info;
    invoke_dlmm_signed(&close_ix, &close_infos, &[signer_seeds])?;

    msg!(
        "dlmm_withdraw_close: stealth={} pa={} position={} bps={}",
        stealth_key,
        pa_key,
        stored_position,
        bps_to_remove,
    );

    Ok(())
}
