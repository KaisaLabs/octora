use anchor_lang::prelude::*;

use crate::constants::{DAMM_PROGRAM_ID, POOL_AUTHORITY_SEED};
use crate::cpi::damm::*;
use crate::errors::ExecutorError;
use crate::state::{PoolAuthority, PoolRef};

/// Initialize a DAMM position: create PoolAuthority + lock escrow via CPI.
/// The lock escrow is created with 0 initial amount; actual LP tokens
/// are locked during damm_deposit.
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

    /// DAMM pool that will hold the position liquidity
    pub pool: UncheckedAccount<'info>,

    /// The LP mint for this DAMM pool
    pub lp_mint: UncheckedAccount<'info>,

    pub damm_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DammInit<'info>>,
    exit_recipient: Pubkey,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.damm_program.key(),
        DAMM_PROGRAM_ID,
        ExecutorError::DammProgramMismatch,
    );

    let pool = ctx.accounts.pool.key();
    let lp_mint = ctx.accounts.lp_mint.key();
    let pa_key = ctx.accounts.pool_authority.key();
    let stealth_key = ctx.accounts.stealth.key();
    let bump = ctx.bumps.pool_authority;

    // Derive lock_escrow PDA under DAMM program
    let (lock_escrow, _escrow_bump) = derive_lock_escrow(&pool, &pa_key);

    // Store state in PoolAuthority
    let pa = &mut ctx.accounts.pool_authority;
    pa.stealth_pubkey = stealth_key;
    pa.exit_recipient = exit_recipient;
    pa.pool_ref = PoolRef::Damm {
        pool,
        lp_mint,
        lock_escrow,
    };
    pa.bump = bump;

    // CPI to DAMM's `lock` instruction to create the lock escrow (amount = 0)
    let remaining = ctx.remaining_accounts;
    require!(remaining.len() >= 17, ExecutorError::AccountsTooShort);

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
                // index 3 = owner = PDA signer
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

    let args = serialize_lock_args(0); // 0 amount = create escrow only
    let ix = build_damm_ix("lock", metas, args);

    // Fix #4: CPI signer re-pinning
    let pa_info = ctx.accounts.pool_authority.to_account_info();
    let mut infos: Vec<AccountInfo> = remaining.to_vec();
    infos[3] = pa_info;
    invoke_damm_signed(&ix, &infos, signer_seeds)?;

    msg!(
        "damm_init: stealth={} pa={} pool={} lp_mint={} lock_escrow={}",
        stealth_key,
        pa_key,
        pool,
        lp_mint,
        lock_escrow,
    );

    Ok(())
}
