use anchor_lang::prelude::*;

use crate::constants::{DAMM_PROGRAM_ID, POOL_AUTHORITY_SEED};
use crate::cpi::damm::*;
use crate::cpi::{require_spl_token_program, require_token_account_owner};
use crate::errors::ExecutorError;
use crate::state::{PoolAuthority, PoolRef};

/// Claim fees from DAMM lock escrow via claimFee CPI.
#[derive(Accounts)]
pub struct DammClaimFees<'info> {
    pub stealth: Signer<'info>,

    #[account(
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), pool_authority.pool_ref.pool_key().as_ref()],
        bump = pool_authority.bump,
        constraint = pool_authority.stealth_pubkey == stealth.key()
            @ ExecutorError::StealthMismatch,
    )]
    pub pool_authority: Account<'info, PoolAuthority>,

    pub pool: UncheckedAccount<'info>,

    pub damm_program: UncheckedAccount<'info>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DammClaimFees<'info>>,
    max_amount: u64,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.damm_program.key(),
        DAMM_PROGRAM_ID,
        ExecutorError::DammProgramMismatch,
    );

    let pa = &ctx.accounts.pool_authority;
    let pool = ctx.accounts.pool.key();

    let (stored_pool, stored_lp_mint, stored_lock_escrow) = match &pa.pool_ref {
        PoolRef::Damm {
            pool: p,
            lp_mint,
            lock_escrow,
        } => (*p, *lp_mint, *lock_escrow),
        PoolRef::Dlmm { .. } => return err!(ExecutorError::InvalidPoolRefType),
    };
    require_keys_eq!(pool, stored_pool, ExecutorError::DammPoolMismatch);

    let remaining = ctx.remaining_accounts;
    require!(remaining.len() >= 18, ExecutorError::AccountsTooShort);

    // Validate CPI forwarded pool + lp_mint against stored state
    require_keys_eq!(
        remaining[0].key(),
        stored_pool,
        ExecutorError::DammPoolMismatch,
    );
    require_keys_eq!(
        remaining[1].key(),
        stored_lp_mint,
        ExecutorError::DammLpMintMismatch,
    );

    // Validate lock escrow
    require_keys_eq!(
        remaining[2].key(),
        stored_lock_escrow,
        ExecutorError::LockEscrowMismatch,
    );

    // Validate destination token accounts (indices 15, 16)
    require_token_account_owner(&remaining[15], &pa.exit_recipient)?;
    require_token_account_owner(&remaining[16], &pa.exit_recipient)?;

    // Validate token program (index 6)
    require_spl_token_program(&remaining[6])?;

    let pa_key = pa.key();
    let pa_info = ctx.accounts.pool_authority.to_account_info();
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
            if i == 3 {
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

    let args = serialize_claim_fee_args(max_amount);
    let ix = build_damm_ix("claimFee", metas, args);

    let mut infos: Vec<AccountInfo> = remaining.to_vec();
    infos[3] = pa_info;
    invoke_damm_signed(&ix, &infos, signer_seeds)?;

    msg!(
        "damm_claim_fees: stealth={} pa={} pool={} lock_escrow={}",
        ctx.accounts.stealth.key(),
        pa_key,
        pool,
        stored_lock_escrow,
    );

    Ok(())
}
