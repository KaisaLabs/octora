use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::POOL_AUTHORITY_SEED;
use crate::cpi::dlmm::*;
use crate::cpi::require_spl_token_program;
use crate::errors::ExecutorError;
use crate::state::{PoolAuthority, PoolRef};

#[derive(Accounts)]
pub struct DlmmAddLiquidity<'info> {
    pub stealth: Signer<'info>,

    #[account(
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), lb_pair.key().as_ref()],
        bump = pool_authority.bump,
        constraint = pool_authority.stealth_pubkey == stealth.key()
            @ ExecutorError::StealthMismatch,
    )]
    pub pool_authority: Account<'info, PoolAuthority>,

    pub dlmm_program: UncheckedAccount<'info>,

    pub lb_pair: UncheckedAccount<'info>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DlmmAddLiquidity<'info>>,
    liquidity_params: Vec<u8>,
) -> Result<()> {
    require_dlmm_program(&ctx.accounts.dlmm_program)?;

    let pa = &ctx.accounts.pool_authority;
    let remaining = ctx.remaining_accounts;
    require!(remaining.len() >= 16, ExecutorError::AccountsTooShort);

    match &pa.pool_ref {
        PoolRef::Dlmm {
            lb_pair: stored_lb_pair,
            position,
        } => {
            require_keys_eq!(
                remaining[0].key(),
                *position,
                ExecutorError::PositionMismatch
            );
            require_keys_eq!(
                remaining[1].key(),
                *stored_lb_pair,
                ExecutorError::LbPairMismatch
            );
        }
        PoolRef::Damm { .. } => return err!(ExecutorError::InvalidPoolRefType),
    }

    require_keys_eq!(
        remaining[1].key(),
        ctx.accounts.lb_pair.key(),
        ExecutorError::LbPairMismatch
    );

    require_spl_token_program(&remaining[12])?;
    require_spl_token_program(&remaining[13])?;
    require_dlmm_event_authority(&remaining[14])?;
    require_dlmm_program(&remaining[15])?;

    let pa_key = pa.key();
    let metas: Vec<AccountMeta> = remaining
        .iter()
        .enumerate()
        .map(|(i, ai)| {
            if i == 11 {
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
        .collect();

    let ix = build_dlmm_ix("add_liquidity_by_strategy", metas, liquidity_params);

    let stealth_key = ctx.accounts.stealth.key();
    let bump = pa.bump;
    let lb_pair_key = match &pa.pool_ref {
        PoolRef::Dlmm { lb_pair, .. } => *lb_pair,
        _ => return err!(ExecutorError::InvalidPoolRefType),
    };
    let signer_seeds: &[&[u8]] = &[
        POOL_AUTHORITY_SEED,
        stealth_key.as_ref(),
        lb_pair_key.as_ref(),
        &[bump],
    ];

    // Fix #4: CPI signer re-pinning
    let pa_info = ctx.accounts.pool_authority.to_account_info();
    let mut infos: Vec<AccountInfo> = remaining.to_vec();
    infos[11] = pa_info;
    invoke_dlmm_signed(&ix, &infos, &[signer_seeds])?;

    msg!(
        "dlmm_add_liquidity: stealth={} pa={} position={}",
        stealth_key,
        pa_key,
        remaining[0].key(),
    );

    Ok(())
}
