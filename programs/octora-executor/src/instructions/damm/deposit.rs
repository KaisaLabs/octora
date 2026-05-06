use anchor_lang::prelude::*;

use crate::constants::{DAMM_PROGRAM_ID, POOL_AUTHORITY_SEED};
use crate::cpi::damm::*;
use crate::cpi::require_spl_token_program;
use crate::errors::ExecutorError;
use crate::state::{PoolAuthority, PoolRef};

/// Single-side SOL deposit + lock LP tokens into escrow.
/// Step 1: addBalanceLiquidity → LP tokens minted to userPoolLp
/// Step 2: lock → LP tokens transferred to lock_escrow
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

    pub damm_program: UncheckedAccount<'info>,

    pub pool: UncheckedAccount<'info>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DammDeposit<'info>>,
    pool_token_amount: u64,
    max_sol: u64,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.damm_program.key(),
        DAMM_PROGRAM_ID,
        ExecutorError::DammProgramMismatch,
    );

    let pa = &ctx.accounts.pool_authority;
    let pool = ctx.accounts.pool.key();

    // Validate pool type + stored ref
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
    // addBalanceLiquidity: 16 accounts (0-15), token_program at 15
    // Followed by lock accounts (another ~15, starting at index 16)
    require!(remaining.len() >= 31, ExecutorError::AccountsTooShort);

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

    // Validate token program for addBalanceLiquidity (index 15)
    require_spl_token_program(&remaining[15])?;

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

    // ── CPI 1: addBalanceLiquidity ──────────────────────────
    let add_metas: Vec<anchor_lang::solana_program::instruction::AccountMeta> = remaining[..16]
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

    let add_args = serialize_add_balance_liquidity_args(pool_token_amount, max_sol, 0);
    let add_ix = build_damm_ix("addBalanceLiquidity", add_metas, add_args);

    let mut add_infos: Vec<AccountInfo> = remaining[..16].to_vec();
    add_infos[13] = pa_info.clone();
    invoke_damm_signed(&add_ix, &add_infos, signer_seeds)?;

    // ── CPI 2: lock LP tokens ────────────────────────────────
    // Lock accounts start at remaining[16].
    // IDL accounts: pool, lpMint, lockEscrow, owner, sourceTokens, escrowVault,
    // tokenProgram, aVault, bVault, aVaultLp, bVaultLp, aVaultLpMint, bVaultLpMint.
    let lock_remaining = &remaining[16..];
    require!(lock_remaining.len() >= 13, ExecutorError::AccountsTooShort);
    let lock_accounts = &lock_remaining[..13];

    // Validate lock CPI forwarded pool + lp_mint + escrow.
    require_keys_eq!(
        lock_accounts[0].key(),
        stored_pool,
        ExecutorError::DammPoolMismatch,
    );
    require_keys_eq!(
        lock_accounts[1].key(),
        stored_lp_mint,
        ExecutorError::DammLpMintMismatch,
    );
    require_keys_eq!(
        lock_accounts[2].key(),
        stored_lock_escrow,
        ExecutorError::LockEscrowMismatch,
    );
    require_keys_eq!(
        lock_accounts[3].key(),
        pa_key,
        ExecutorError::DammSolOwnerMismatch,
    );

    // Validate token program for lock (index 6)
    require_spl_token_program(&lock_accounts[6])?;

    let lock_metas: Vec<anchor_lang::solana_program::instruction::AccountMeta> = lock_accounts
        .iter()
        .enumerate()
        .map(|(i, ai)| {
            if i == 3 {
                // owner at index 3 = PDA signer
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

    // Lock the full pool_token_amount
    let lock_args = serialize_lock_args(pool_token_amount);
    let lock_ix = build_damm_ix("lock", lock_metas, lock_args);

    let mut lock_infos: Vec<AccountInfo> = lock_accounts.to_vec();
    lock_infos[3] = pa_info;
    invoke_damm_signed(&lock_ix, &lock_infos, signer_seeds)?;

    msg!(
        "damm_deposit: stealth={} pa={} pool={} pool_tokens={}",
        stealth_key,
        pa_key,
        pool,
        pool_token_amount,
    );

    Ok(())
}
