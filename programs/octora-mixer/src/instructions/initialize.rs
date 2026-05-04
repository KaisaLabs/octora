use anchor_lang::prelude::*;
use crate::constants::*;
use crate::state::MixerPool;

#[derive(Accounts)]
#[instruction(denomination: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    // Boxed because MixerPool is now ~1.6KB after adding filled_subtrees,
    // and the auto-generated `try_accounts` would otherwise blow the SBF
    // 4KB stack budget. The Box puts the deserialized struct on the heap
    // and leaves only an 8-byte pointer in the Accounts frame.
    #[account(
        init,
        payer = authority,
        space = MixerPool::SPACE,
        seeds = [MIXER_POOL_SEED, &denomination.to_le_bytes()],
        bump,
    )]
    pub mixer_pool: Box<Account<'info, MixerPool>>,

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

    // The empty-tree root is ZERO_HASHES[TREE_LEVELS - 1] — the hash of an
    // all-zeros subtree at the top level. The off-chain Merkle tree must
    // produce the same value for an empty tree, otherwise the very first
    // withdrawal proof will fail.
    pool.root_history[0] = ZERO_HASHES[TREE_LEVELS - 1];

    // Seed filled_subtrees with the per-level zero hashes so the first
    // (even-index) insertion behaves exactly like a fresh tree.
    for (i, slot) in pool.filled_subtrees.iter_mut().enumerate() {
        *slot = ZERO_HASHES[i];
    }

    msg!("Mixer pool initialized with denomination: {} lamports", denomination);

    Ok(())
}
