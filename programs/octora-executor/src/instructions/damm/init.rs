use anchor_lang::prelude::*;

use crate::constants::{DAMM_PROGRAM_ID, POOL_AUTHORITY_SEED};
use crate::errors::ExecutorError;
use crate::state::{PoolAuthority, PoolRef};

/// Initialize a DAMM pool position tracker.
/// Creates PoolAuthority PDA — no DAMM CPI needed.
#[derive(Accounts)]
pub struct DammInit<'info> {
    #[account(mut)]
    pub stealth: Signer<'info>,

    #[account(
        init,
        payer = stealth,
        space = PoolAuthority::SPACE,
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), pool.key().as_ref()],
        bump,
    )]
    pub pool_authority: Account<'info, PoolAuthority>,

    /// The DAMM pool this position targets.
    pub pool: UncheckedAccount<'info>,

    pub damm_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<DammInit>, exit_recipient: Pubkey) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.damm_program.key(),
        DAMM_PROGRAM_ID,
        ExecutorError::DammProgramMismatch,
    );

    let pa = &mut ctx.accounts.pool_authority;
    let stealth_key = ctx.accounts.stealth.key();
    let pool = ctx.accounts.pool.key();

    pa.stealth_pubkey = stealth_key;
    pa.exit_recipient = exit_recipient;
    pa.pool_ref = PoolRef::Damm {
        pool,
        // lp_mint and lock_escrow are not used without lock_escrow
        // We set them to zero/pubkey::default since we removed lock_escrow
        lp_mint: Pubkey::default(),
        lock_escrow: Pubkey::default(),
    };
    pa.bump = ctx.bumps.pool_authority;

    msg!(
        "damm_init: stealth={} pa={} pool={}",
        stealth_key,
        pa.key(),
        pool,
    );

    Ok(())
}
