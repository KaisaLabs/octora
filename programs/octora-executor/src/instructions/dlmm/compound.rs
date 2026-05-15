use anchor_lang::prelude::*;

use crate::constants::CONFIG_SEED;
use crate::cpi::dlmm::require_dlmm_program;
use crate::cpi::require_mixer_program;
use crate::errors::ExecutorError;
use crate::state::Config;

#[derive(Accounts)]
pub struct CompoundWithdrawAddLiquidity<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,

    /// CHECK: future implementation must bind this to the mixer proof recipient
    /// and the DLMM Position owner.
    pub stealth: UncheckedAccount<'info>,

    /// CHECK: validated against the canonical Octora mixer program ID.
    pub mixer_program: UncheckedAccount<'info>,

    /// CHECK: validated against the canonical Meteora DLMM program ID.
    pub dlmm_program: UncheckedAccount<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ ExecutorError::Paused,
    )]
    pub config: Account<'info, Config>,
}

pub fn withdraw_add_liquidity_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, CompoundWithdrawAddLiquidity<'info>>,
    _withdraw_proof_data: [u8; 256],
    _withdraw_public_inputs: [u8; 160],
    _liquidity_params: Vec<u8>,
) -> Result<()> {
    require_mixer_program(&ctx.accounts.mixer_program)?;
    require_dlmm_program(&ctx.accounts.dlmm_program)?;

    msg!(
        "compound_withdraw_add_liquidity unsupported: relayer={} stealth={}",
        ctx.accounts.relayer.key(),
        ctx.accounts.stealth.key(),
    );

    err!(ExecutorError::CompoundCpiUnsupported)
}

#[derive(Accounts)]
pub struct CompoundClaimFeesDeposit<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,

    /// CHECK: future implementation must bind this to the DLMM Position owner
    /// and mixer Commitment payer semantics.
    pub stealth: UncheckedAccount<'info>,

    /// CHECK: validated against the canonical Octora mixer program ID.
    pub mixer_program: UncheckedAccount<'info>,

    /// CHECK: validated against the canonical Meteora DLMM program ID.
    pub dlmm_program: UncheckedAccount<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ ExecutorError::Paused,
    )]
    pub config: Account<'info, Config>,
}

pub fn claim_fees_deposit_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, CompoundClaimFeesDeposit<'info>>,
    claimed_fee_amount: u64,
    denomination: u64,
    requested_deposit_amount: u64,
    _commitment: [u8; 32],
    _remaining_accounts_info: Vec<u8>,
) -> Result<()> {
    require_mixer_program(&ctx.accounts.mixer_program)?;
    require_dlmm_program(&ctx.accounts.dlmm_program)?;

    let floor_amount = floor_to_denomination(claimed_fee_amount, denomination)?;
    require!(
        requested_deposit_amount == floor_amount,
        ExecutorError::CompoundDepositAmountMismatch,
    );

    msg!(
        "compound_claim_fees_deposit unsupported: relayer={} stealth={} floor_amount={}",
        ctx.accounts.relayer.key(),
        ctx.accounts.stealth.key(),
        floor_amount,
    );

    err!(ExecutorError::CompoundCpiUnsupported)
}

pub fn floor_to_denomination(amount: u64, denomination: u64) -> Result<u64> {
    require!(denomination > 0, ExecutorError::InvalidDenomination);
    Ok(amount - (amount % denomination))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_to_denomination_handles_exact_multiple() {
        assert_eq!(
            floor_to_denomination(1_000_000_000, 100_000_000).unwrap(),
            1_000_000_000,
        );
    }

    #[test]
    fn floor_to_denomination_rounds_down() {
        assert_eq!(
            floor_to_denomination(199_999_999, 100_000_000).unwrap(),
            100_000_000,
        );
    }

    #[test]
    fn floor_to_denomination_keeps_sub_denom_at_zero() {
        assert_eq!(floor_to_denomination(99_999_999, 100_000_000).unwrap(), 0);
    }

    #[test]
    fn floor_to_denomination_rejects_zero_denomination() {
        assert!(floor_to_denomination(1, 0).is_err());
    }
}
