use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::MixerError;
use crate::events::PausedEvent;
use crate::state::MixerPool;

/// Authority-gated emergency pause toggle.
///
/// `pool.is_paused` blocks both deposit and withdraw. The authority is set
/// at `initialize` and is the only key allowed to flip this flag — losing
/// the authority key permanently strands the pause control.
#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub authority: Signer<'info>,

    // Zero-copy — see Initialize for the rationale.
    #[account(
        mut,
        seeds = [MIXER_POOL_SEED, &mixer_pool.load()?.denomination.to_le_bytes()],
        bump = mixer_pool.load()?.bump,
        has_one = authority @ MixerError::Unauthorized,
    )]
    pub mixer_pool: AccountLoader<'info, MixerPool>,
}

pub fn handler(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    let mut pool = ctx.accounts.mixer_pool.load_mut()?;
    // `is_paused` is u8 in the zero-copy struct (bytemuck::Pod rejects bool).
    pool.is_paused = if paused { 1 } else { 0 };
    let denomination = pool.denomination;
    drop(pool);

    let clock = Clock::get()?;
    emit!(PausedEvent {
        denomination,
        paused,
        authority: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });

    msg!("Mixer pool denomination {} pause = {}", denomination, paused);
    Ok(())
}
