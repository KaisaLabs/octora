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

    /// Scaffold for `mixer.withdraw -> dlmm.add_liquidity`.
    ///
    /// This entrypoint is exported deliberately, but fails closed until the
    /// architecture decides how Executor may CPI into Mixer and convert the
    /// withdrawn SOL into the DLMM token accounts without exposing a Stealth
    /// Wallet free-balance interval.
    pub fn compound_withdraw_add_liquidity<'info>(
        ctx: Context<'_, '_, '_, 'info, CompoundWithdrawAddLiquidity<'info>>,
        withdraw_proof_data: [u8; 256],
        withdraw_public_inputs: [u8; 160],
        liquidity_params: Vec<u8>,
    ) -> Result<()> {
        instructions::dlmm::compound::withdraw_add_liquidity_handler(
            ctx,
            withdraw_proof_data,
            withdraw_public_inputs,
            liquidity_params,
        )
    }

    pub fn dlmm_claim_fees<'info>(
        ctx: Context<'_, '_, '_, 'info, DlmmClaimFees<'info>>,
        min_bin_id: i32,
        max_bin_id: i32,
        remaining_accounts_info: Vec<u8>,
    ) -> Result<()> {
        instructions::dlmm::claim_fees::handler(
            ctx,
            min_bin_id,
            max_bin_id,
            remaining_accounts_info,
        )
    }

    /// Scaffold for `dlmm.claim_fee -> mixer.deposit`.
    ///
    /// The floor-round invariant is enforced now; the instruction still fails
    /// closed because residual reinsertion into the DLMM Position is not
    /// possible with the currently available CPI surface.
    pub fn compound_claim_fees_deposit<'info>(
        ctx: Context<'_, '_, '_, 'info, CompoundClaimFeesDeposit<'info>>,
        claimed_fee_amount: u64,
        denomination: u64,
        requested_deposit_amount: u64,
        commitment: [u8; 32],
        remaining_accounts_info: Vec<u8>,
    ) -> Result<()> {
        instructions::dlmm::compound::claim_fees_deposit_handler(
            ctx,
            claimed_fee_amount,
            denomination,
            requested_deposit_amount,
            commitment,
            remaining_accounts_info,
        )
    }

    pub fn dlmm_withdraw_close<'info>(
        ctx: Context<'_, '_, '_, 'info, DlmmWithdrawClose<'info>>,
        from_bin_id: i32,
        to_bin_id: i32,
        bps_to_remove: u16,
        remaining_accounts_info: Vec<u8>,
    ) -> Result<()> {
        instructions::dlmm::withdraw_close::handler(
            ctx,
            from_bin_id,
            to_bin_id,
            bps_to_remove,
            remaining_accounts_info,
        )
    }

    /// Pause-gated, slippage-enforced wrapper around Meteora DLMM `swap2`.
    /// Used by the swap layer to convert SOL ↔ target token before LP, so any
    /// DLMM pair (including memecoins, Token-2022) can be reached without
    /// per-token mixer pools. Source pool must differ from the LP target pool
    /// — enforced by the backend orchestrator, not this instruction.
    pub fn dlmm_swap<'info>(
        ctx: Context<'_, '_, '_, 'info, DlmmSwap<'info>>,
        amount_in: u64,
        min_amount_out: u64,
        remaining_accounts_info: Vec<u8>,
    ) -> Result<()> {
        instructions::dlmm::swap::handler(ctx, amount_in, min_amount_out, remaining_accounts_info)
    }
}
