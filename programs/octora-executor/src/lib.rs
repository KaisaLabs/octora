use anchor_lang::prelude::*;

pub mod constants;
pub mod dlmm;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

// Placeholder program ID — run `anchor keys sync` after the first build to
// replace this with the keypair under `target/deploy/octora_executor-keypair.json`,
// then redeploy.
declare_id!("86zj6EvHxMywP4Bw4EyZ2VcAjLm1pfGsc6ZjsZbrWwwc");

#[program]
pub mod octora_executor {
    use super::*;

    /// Initialise a Meteora DLMM position owned by a `PositionAuthority` PDA
    /// derived from the stealth wallet. Forwards account list to DLMM's
    /// `initialize_position` ix.
    pub fn init_position<'info>(
        ctx: Context<'_, '_, '_, 'info, InitPosition<'info>>,
        lower_bin_id: i32,
        width: i32,
    ) -> Result<()> {
        instructions::init_position::handler(ctx, lower_bin_id, width)
    }

    /// Add liquidity to a previously-initialised DLMM position. The stealth
    /// wallet authorises; the PDA signs the inner Meteora CPI as position
    /// owner.
    ///
    /// `liquidity_params` is the Borsh-encoded `LiquidityParameterByStrategy`
    /// blob expected by DLMM. We forward bytes verbatim to stay decoupled
    /// from Meteora's strategy enum.
    pub fn add_liquidity<'info>(
        ctx: Context<'_, '_, '_, 'info, AddLiquidity<'info>>,
        liquidity_params: Vec<u8>,
    ) -> Result<()> {
        instructions::add_liquidity::handler(ctx, liquidity_params)
    }
}
