use anchor_lang::prelude::*;

use crate::constants::{DAMM_PROGRAM_ID, POOL_AUTHORITY_SEED};
use crate::cpi::damm::*;
use crate::cpi::require_token_account_owner;
use crate::errors::ExecutorError;
use crate::state::{PoolAuthority, PoolRef};

/// Remove liquidity from a DAMM pool via removeBalanceLiquidity.
/// Tokens flow to exit_recipient ATAs. PoolAuthority is closed.
#[derive(Accounts)]
pub struct DammWithdraw<'info> {
    #[account(mut)]
    pub stealth: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), pool_authority.pool_ref.pool_key().as_ref()],
        bump = pool_authority.bump,
        constraint = pool_authority.stealth_pubkey == stealth.key()
            @ ExecutorError::StealthMismatch,
        close = stealth, // Fix #3: close PoolAuthority
    )]
    pub pool_authority: Account<'info, PoolAuthority>,

    pub damm_program: UncheckedAccount<'info>,

    pub pool: UncheckedAccount<'info>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DammWithdraw<'info>>,
    pool_token_amount: u64,
    min_sol_out: u64,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.damm_program.key(),
        DAMM_PROGRAM_ID,
        ExecutorError::DammProgramMismatch,
    );

    let pa = &ctx.accounts.pool_authority;
    let pool = ctx.accounts.pool.key();

    match &pa.pool_ref {
        PoolRef::Damm {
            pool: stored_pool, ..
        } => {
            require_keys_eq!(pool, *stored_pool, ExecutorError::DammPoolMismatch);
        }
        PoolRef::Dlmm { .. } => return err!(ExecutorError::InvalidPoolRefType),
    }

    let remaining = ctx.remaining_accounts;
    require!(remaining.len() >= 16, ExecutorError::AccountsTooShort);

    // Fix #6: Validate destination token accounts owned by exit_recipient
    require_token_account_owner(&remaining[11], &pa.exit_recipient)?;
    require_token_account_owner(&remaining[12], &pa.exit_recipient)?;

    let pa_key = pa.key();
    let stealth_key = ctx.accounts.stealth.key();
    let bump = pa.bump;

    let signer_seeds: &[&[&[u8]]] = &[&[
        POOL_AUTHORITY_SEED,
        stealth_key.as_ref(),
        pool.as_ref(),
        &[bump],
    ]];

    let metas: Vec<anchor_lang::solana_program::instruction::AccountMeta> = remaining
        .iter()
        .enumerate()
        .map(|(i, ai)| {
            if i == 13 {
                // user/sender at index 13 = PDA signer
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

    // Single-side SOL: min_quote_out = 0 (forced)
    let args = serialize_remove_balance_liquidity_args(pool_token_amount, min_sol_out, 0);
    let ix = build_damm_ix("removeBalanceLiquidity", metas, args);

    // Fix #4: CPI signer re-pinning
    let pa_info = ctx.accounts.pool_authority.to_account_info();
    let mut infos: Vec<AccountInfo> = remaining.to_vec();
    infos[13] = pa_info;
    invoke_damm_signed(&ix, &infos, signer_seeds)?;

    msg!(
        "damm_withdraw: stealth={} pa={} pool={} pool_tokens={}",
        stealth_key,
        pa_key,
        pool,
        pool_token_amount,
    );

    Ok(())
}
