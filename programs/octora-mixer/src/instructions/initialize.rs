use anchor_lang::prelude::*;
use crate::constants::*;
use crate::state::MixerPool;

#[derive(Accounts)]
#[instruction(denomination: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = MixerPool::SPACE,
        seeds = [MIXER_POOL_SEED, &denomination.to_le_bytes()],
        bump,
    )]
    pub mixer_pool: Account<'info, MixerPool>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, denomination: u64) -> Result<()> {
    let pool = &mut ctx.accounts.mixer_pool;

    pool.authority = ctx.accounts.authority.key();
    pool.denomination = denomination;
    pool.next_leaf_index = 0;
    pool.current_root_index = 0;
    pool.is_paused = false;
    pool.bump = ctx.bumps.mixer_pool;

    // Compute the initial empty-tree root from precomputed zero hashes.
    // The root of an empty 20-level tree is ZERO_HASHES[19]
    // (or ZERO_VALUE if ZERO_HASHES haven't been computed yet).
    //
    // For now, we use the precomputed constant. This MUST match
    // the off-chain Merkle tree's initial root exactly.
    pool.root_history[0] = ZERO_HASHES[TREE_LEVELS - 1];

    msg!("Mixer pool initialized with denomination: {} lamports", denomination);

    Ok(())
}
