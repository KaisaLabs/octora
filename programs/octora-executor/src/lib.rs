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

    // ═══ Admin Instructions ═══
    //
    // `init_config` is gated on `EXECUTOR_ADMIN_AUTHORITY` (see
    // `constants.rs`) and must be the very first instruction sent to a
    // freshly deployed program — every state-mutating DLMM instruction
    // requires the global `Config` PDA to exist *and* `paused == false`.

    pub fn init_config(ctx: Context<InitConfig>) -> Result<()> {
        instructions::admin::init_config_handler(ctx)
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::admin::set_paused_handler(ctx, paused)
    }

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

    /// Pause-gated, slippage-enforced wrapper around Meteora DLMM `swap`.
    /// Used by the swap layer to convert SOL ↔ target token before LP, so any
    /// DLMM pair (including memecoins) can be reached without per-token mixer
    /// pools. Source pool must differ from the LP target pool — enforced by
    /// the backend orchestrator, not this instruction.
    pub fn dlmm_swap<'info>(
        ctx: Context<'_, '_, '_, 'info, DlmmSwap<'info>>,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        instructions::dlmm::swap::handler(ctx, amount_in, min_amount_out)
    }

}
