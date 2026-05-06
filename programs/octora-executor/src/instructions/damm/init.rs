use anchor_lang::prelude::*;

use crate::constants::{DAMM_PROGRAM_ID, POOL_AUTHORITY_SEED};
use crate::cpi::damm::*;
use crate::errors::ExecutorError;
use crate::state::{PoolAuthority, PoolRef};

/// Initialize a DAMM position: create PoolAuthority + lock escrow via DAMM CPI.
/// Uses DAMM's `createLockEscrow` instruction to create the escrow account.
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

    /// DAMM pool account
    pub pool: UncheckedAccount<'info>,

    /// LP mint for this DAMM pool
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

    // Derive lock_escrow PDA
    let (lock_escrow, _escrow_bump) = derive_lock_escrow(&pool, &pa_key);

    // Store state
    let pa = &mut ctx.accounts.pool_authority;
    pa.stealth_pubkey = stealth_key;
    pa.exit_recipient = exit_recipient;
    pa.pool_ref = PoolRef::Damm {
        pool,
        lp_mint,
        lock_escrow,
    };
    pa.bump = bump;

    // CPI to DAMM's `createLockEscrow`.
    // IDL accounts: pool, lockEscrow, owner, lpMint, payer, systemProgram.
    let remaining = ctx.remaining_accounts;
    require!(remaining.len() >= 6, ExecutorError::AccountsTooShort);

    require_keys_eq!(remaining[0].key(), pool, ExecutorError::DammPoolMismatch);
    require_keys_eq!(
        remaining[1].key(),
        lock_escrow,
        ExecutorError::LockEscrowMismatch
    );
    require_keys_eq!(
        remaining[2].key(),
        pa_key,
        ExecutorError::DammSolOwnerMismatch
    );
    require_keys_eq!(
        remaining[3].key(),
        lp_mint,
        ExecutorError::DammLpMintMismatch
    );
    require_keys_eq!(
        remaining[4].key(),
        stealth_key,
        ExecutorError::StealthMismatch
    );
    require_keys_eq!(
        remaining[5].key(),
        ctx.accounts.system_program.key(),
        ExecutorError::InvalidSysAccount
    );

    let create_accounts = &remaining[..6];
    let mut metas: Vec<anchor_lang::solana_program::instruction::AccountMeta> = create_accounts
        .iter()
        .map(|ai| AccountMeta {
            pubkey: ai.key(),
            is_signer: ai.is_signer,
            is_writable: ai.is_writable,
        })
        .collect();
    metas[2] = AccountMeta {
        pubkey: pa_key,
        is_signer: false,
        is_writable: false,
    };

    let ix = build_damm_ix("createLockEscrow", metas, Vec::new());

    let mut infos: Vec<AccountInfo> = create_accounts.to_vec();
    infos[2] = ctx.accounts.pool_authority.to_account_info();
    invoke_damm_signed(&ix, &infos, &[])?;

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
