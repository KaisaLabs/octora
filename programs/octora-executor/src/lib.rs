use anchor_lang::prelude::*;

pub mod constants;
pub mod cpi;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("86zj6EvHxMywP4Bw4EyZ2VcAjLm1pfGsc6ZjsZbrWwwc");

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
}
