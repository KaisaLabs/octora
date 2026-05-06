use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::MixerError;
use crate::state::MixerPool;

/// Authority-gated emergency pause toggle.
///
/// `pool.is_paused` blocks both deposit and withdraw. The authority is set
/// at `initialize` and is the only key allowed to flip this flag — losing
/// the authority key permanently strands the pause control.
#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [MIXER_POOL_SEED, &mixer_pool.denomination.to_le_bytes()],
        bump = mixer_pool.bump,
        has_one = authority @ MixerError::Unauthorized,
    )]
    pub mixer_pool: Box<Account<'info, MixerPool>>,
}

pub fn handler(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    let pool = &mut ctx.accounts.mixer_pool;
    pool.is_paused = paused;
    msg!("Mixer pool denomination {} pause = {}", pool.denomination, paused);
    Ok(())
}
