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
) -> Result<()> {
    require!(from_bin_id <= to_bin_id, ExecutorError::ArgOutOfRange);
    require!(
        bps_to_remove > 0 && bps_to_remove <= 10_000,
        ExecutorError::ArgOutOfRange
    );
    require_dlmm_program(&ctx.accounts.dlmm_program)?;

    let pa = &ctx.accounts.pool_authority;
    let remaining = ctx.remaining_accounts;
    require!(remaining.len() == 17, ExecutorError::AccountsTooShort);

    let (stored_lb_pair, stored_position) = match &pa.pool_ref {
        PoolRef::Dlmm { lb_pair, position } => (*lb_pair, *position),
        _ => return Err(error!(ExecutorError::InvalidPoolRefType)),
    };

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
    require_token_account_mint(&remaining[3], &remaining[12], &remaining[7].key())?;
    require_token_account_mint(&remaining[4], &remaining[13], &remaining[8].key())?;
    require_spl_token_program(&remaining[12])?;
    require_spl_token_program(&remaining[13])?;
    require_dlmm_event_authority(&remaining[14])?;
    require_dlmm_program(&remaining[15])?;
    require_keys_eq!(
        remaining[16].key(),
        pa.exit_recipient,
        ExecutorError::ExitRecipientMismatch
    );
    require_keys_neq!(
        remaining[16].key(),
        remaining[0].key(),
        ExecutorError::PositionMismatch
    );
    require_keys_neq!(
        remaining[16].key(),
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

    // CPI 1: remove_liquidity_by_range
    let remove_indices: Vec<usize> = (0..=15).collect();
    let remove_metas = build_metas(&remove_indices, 11);
    let mut remove_args = Vec::with_capacity(10);
    remove_args.extend_from_slice(&from_bin_id.to_le_bytes());
    remove_args.extend_from_slice(&to_bin_id.to_le_bytes());
    remove_args.extend_from_slice(&bps_to_remove.to_le_bytes());
    let remove_ix = build_dlmm_ix("remove_liquidity_by_range", remove_metas, remove_args);

    let mut remove_infos: Vec<AccountInfo> = remaining.to_vec();
    remove_infos[11] = pa_info.clone();
    invoke_dlmm_signed(&remove_ix, &remove_infos, &[signer_seeds])?;

    // CPI 2: close_position
    let close_indices = [0usize, 1, 9, 10, 11, 16, 14, 15];
    let close_metas = build_metas(&close_indices, 11);
    let close_ix = build_dlmm_ix("close_position", close_metas, Vec::new());

    let mut close_infos: Vec<AccountInfo> = remaining.to_vec();
    close_infos[11] = pa_info;
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
