use anchor_lang::prelude::*;

use crate::constants::{DAMM_PROGRAM_ID, POOL_AUTHORITY_SEED};
use crate::errors::ExecutorError;
use crate::state::{PoolAuthority, PoolRef};

/// Claim DAMM pool trading fees into exit_recipient ATAs.
/// Note: Fee claiming without lock_escrow uses DAMM's vault claim mechanism.
/// This instruction validates the claim is legitimate and outflows go to exit_recipient.
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

    /// CHECK: DAMM pool account — validated against stored ref
    pub pool: UncheckedAccount<'info>,

    /// CHECK: DAMM program ID checked in handler
    pub damm_program: UncheckedAccount<'info>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DammClaimFees<'info>>,
    _max_amount: u64,
) -> Result<()> {
    // Validate DAMM program ID
    require_keys_eq!(
        ctx.accounts.damm_program.key(),
        DAMM_PROGRAM_ID,
        ExecutorError::DammProgramMismatch,
    );

    let pa = &ctx.accounts.pool_authority;
    let pool = ctx.accounts.pool.key();

    // Validate pool matches stored ref and is DAMM type
    match &pa.pool_ref {
        PoolRef::Damm {
            pool: stored_pool, ..
        } => {
            require_keys_eq!(pool, *stored_pool, ExecutorError::DammPoolMismatch);
        }
        PoolRef::Dlmm { .. } => return err!(ExecutorError::InvalidPoolRefType),
    }

    let remaining = ctx.remaining_accounts;
    require!(remaining.len() >= 18, ExecutorError::AccountsTooShort);

    // DAMM claimFee requires ~18 remaining accounts (see spec lines 626-647)
    // Standard layout for DAMM claimFee:
    // 0: pool (W), 1: lpMint (W), 2: lockEscrow (W), 3: owner (S)->PDA,
    // 4: sourceTokens (W), 5: escrowVault (W), 6: tokenProgram,
    // 7: aTokenVault (W), 8: bTokenVault (W), 9: aVault (W), 10: bVault (W),
    // 11: aVaultLp (W), 12: bVaultLp (W), 13: aVaultLpMint (W), 14: bVaultLpMint (W),
    // 15: userSolToken (W), 16: userQuoteToken (W), 17: vaultProgram

    // Validate destination token accounts owned by exit_recipient (indices 15, 16)
    use crate::cpi::require_token_account_owner;
    require_token_account_owner(&remaining[15], &pa.exit_recipient)?;
    require_token_account_owner(&remaining[16], &pa.exit_recipient)?;

    // TODO: Implement claimFee CPI once DAMM IDL is fully verified.
    // Currently validates security boundary (exit_recipient) and returns.
    // The actual claimFee CPI requires the correct lock_escrow PDA and vault accounts.

    msg!(
        "damm_claim_fees: stealth={} pool={} validated exit_recipient={}",
        ctx.accounts.stealth.key(),
        pool,
        pa.exit_recipient,
    );

    Ok(())
}
