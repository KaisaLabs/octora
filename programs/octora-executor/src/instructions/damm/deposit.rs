use anchor_lang::prelude::*;

use crate::constants::{DAMM_PROGRAM_ID, POOL_AUTHORITY_SEED};
use crate::cpi::damm::*;
use crate::cpi::require_spl_token_program;
use crate::errors::ExecutorError;
use crate::state::{PoolAuthority, PoolRef};

/// Single-side SOL deposit into a DAMM pool via addBalanceLiquidity.
#[derive(Accounts)]
pub struct DammDeposit<'info> {
    pub stealth: Signer<'info>,

    #[account(
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), pool_authority.pool_ref.pool_key().as_ref()],
        bump = pool_authority.bump,
        constraint = pool_authority.stealth_pubkey == stealth.key()
            @ ExecutorError::StealthMismatch,
    )]
    pub pool_authority: Account<'info, PoolAuthority>,

    /// CHECK: DAMM program ID checked in handler
    pub damm_program: UncheckedAccount<'info>,

    pub pool: UncheckedAccount<'info>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DammDeposit<'info>>,
    pool_token_amount: u64,
    max_sol: u64,
    max_token_b: u64,
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

    require_spl_token_program(&remaining[15])?;

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
            if i == 12 {
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

    let args = serialize_add_balance_liquidity_args(pool_token_amount, max_sol, max_token_b);
    let ix = build_damm_ix("addBalanceLiquidity", metas, args);
    invoke_damm_signed(&ix, remaining, signer_seeds)?;

    msg!(
        "damm_deposit: stealth={} pa={} pool={} pool_tokens={}",
        stealth_key,
        pa_key,
        pool,
        pool_token_amount,
    );

    Ok(())
}
