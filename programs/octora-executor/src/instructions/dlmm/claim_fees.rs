use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::POOL_AUTHORITY_SEED;
use crate::cpi::dlmm::*;
use crate::cpi::{require_spl_token_program, require_token_account_owner};
use crate::errors::ExecutorError;
use crate::state::{PoolAuthority, PoolRef};

#[derive(Accounts)]
pub struct DlmmClaimFees<'info> {
    pub stealth: Signer<'info>,

    #[account(
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), lb_pair.key().as_ref()],
        bump = pool_authority.bump,
        constraint = pool_authority.stealth_pubkey == stealth.key()
            @ ExecutorError::StealthMismatch,
    )]
    pub pool_authority: Account<'info, PoolAuthority>,

    /// CHECK: validated in handler against stored PoolAuthority lb_pair.
    pub lb_pair: UncheckedAccount<'info>,

    /// CHECK: validated in handler against canonical DLMM program ID.
    pub dlmm_program: UncheckedAccount<'info>,
}

pub fn handler<'info>(ctx: Context<'_, '_, '_, 'info, DlmmClaimFees<'info>>) -> Result<()> {
    require_dlmm_program(&ctx.accounts.dlmm_program)?;

    let pa = &ctx.accounts.pool_authority;
    let remaining = ctx.remaining_accounts;
    require!(remaining.len() >= 14, ExecutorError::AccountsTooShort);

    let (stored_lb_pair, stored_position) = match &pa.pool_ref {
        PoolRef::Dlmm { lb_pair, position } => (*lb_pair, *position),
        _ => return Err(error!(ExecutorError::InvalidPoolRefType)),
    };

    require_keys_eq!(
        remaining[0].key(),
        stored_lb_pair,
        ExecutorError::LbPairMismatch
    );
    require_keys_eq!(
        remaining[1].key(),
        stored_position,
        ExecutorError::PositionMismatch
    );
    require_token_account_owner(&remaining[7], &pa.exit_recipient)?;
    require_token_account_owner(&remaining[8], &pa.exit_recipient)?;
    require_spl_token_program(&remaining[11])?;
    require_dlmm_event_authority(&remaining[12])?;
    require_dlmm_program(&remaining[13])?;
    require_keys_eq!(
        ctx.accounts.lb_pair.key(),
        stored_lb_pair,
        ExecutorError::LbPairMismatch
    );

    let pa_key = pa.key();
    let metas: Vec<AccountMeta> = remaining
        .iter()
        .enumerate()
        .map(|(i, ai)| {
            if i == 4 {
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

    let ix = build_dlmm_ix("claim_fee", metas, Vec::new());

    let stealth_key = ctx.accounts.stealth.key();
    let bump = pa.bump;
    let signer_seeds: &[&[u8]] = &[
        POOL_AUTHORITY_SEED,
        stealth_key.as_ref(),
        stored_lb_pair.as_ref(),
        &[bump],
    ];

    // Fix #4: CPI signer re-pinning
    let pa_info = ctx.accounts.pool_authority.to_account_info();
    let mut infos: Vec<AccountInfo> = remaining.to_vec();
    infos[4] = pa_info;
    invoke_dlmm_signed(&ix, &infos, &[signer_seeds])?;

    msg!(
        "dlmm_claim_fees: stealth={} pa={} position={}",
        stealth_key,
        pa_key,
        stored_position,
    );

    Ok(())
}
