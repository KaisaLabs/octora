use anchor_lang::prelude::*;

pub mod constants;
pub mod cpi;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("4n47TYP2hQ2bwS8GiU3a1EVyF9mgeSbKWBvAVmUjaUtK");

#[program]
pub mod octora_executor {
    use super::*;

    // ═══ DLMM Instructions ═══

    pub fn dlmm_init_position<'info>(
        ctx: Context<'_, '_, '_, 'info, DlmmInitPosition<'info>>,
        lower_bin_id: i32,
        width: i32,
        exit_recipient: Pubkey,
    ) -> Result<()> {
        instructions::dlmm::init_position::handler(ctx, lower_bin_id, width, exit_recipient)
    }

    pub fn dlmm_add_liquidity<'info>(
        ctx: Context<'_, '_, '_, 'info, DlmmAddLiquidity<'info>>,
        liquidity_params: Vec<u8>,
    ) -> Result<()> {
        instructions::dlmm::add_liquidity::handler(ctx, liquidity_params)
    }

    pub fn dlmm_claim_fees<'info>(
        ctx: Context<'_, '_, '_, 'info, DlmmClaimFees<'info>>,
    ) -> Result<()> {
        instructions::dlmm::claim_fees::handler(ctx)
    }

    pub fn dlmm_withdraw_close<'info>(
        ctx: Context<'_, '_, '_, 'info, DlmmWithdrawClose<'info>>,
        from_bin_id: i32,
        to_bin_id: i32,
        bps_to_remove: u16,
    ) -> Result<()> {
        instructions::dlmm::withdraw_close::handler(ctx, from_bin_id, to_bin_id, bps_to_remove)
    }

    // ═══ DAMM Instructions ═══

    pub fn damm_init<'info>(
        ctx: Context<'_, '_, '_, 'info, DammInit<'info>>,
        exit_recipient: Pubkey,
    ) -> Result<()> {
        instructions::damm::init::handler(ctx, exit_recipient)
    }

    pub fn damm_deposit<'info>(
        ctx: Context<'_, '_, '_, 'info, DammDeposit<'info>>,
        pool_token_amount: u64,
        max_sol: u64,
    ) -> Result<()> {
        instructions::damm::deposit::handler(ctx, pool_token_amount, max_sol)
    }

    pub fn damm_withdraw<'info>(
        ctx: Context<'_, '_, '_, 'info, DammWithdraw<'info>>,
        pool_token_amount: u64,
        min_sol_out: u64,
    ) -> Result<()> {
        instructions::damm::withdraw::handler(ctx, pool_token_amount, min_sol_out)
    }

    pub fn damm_claim_fees<'info>(
        ctx: Context<'_, '_, '_, 'info, DammClaimFees<'info>>,
        max_amount: u64,
    ) -> Result<()> {
        instructions::damm::claim_fees::handler(ctx, max_amount)
    }
}
