use anchor_lang::prelude::*;
use crate::constants::*;
use crate::state::MixerPool;

// TODO(M-3 — pre-mainnet): `initialize` is currently permissionless. The
// first caller for a given denomination becomes pool.authority forever
// (and, after M-2, holds the pause key). Before mainnet, decide one of:
//   (a) Pin to a single deployer pubkey:
//         #[account(mut, address = ADMIN @ MixerError::Unauthorized)]
//   (b) Pin to a multisig PDA.
//   (c) Keep self-service but split the pause role into a separate
//       global config account.
// Leaving permissionless is acceptable on devnet only.
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
    require!(denomination > 0, crate::errors::MixerError::InvalidDenomination);

    let pool = &mut ctx.accounts.mixer_pool;

    pool.authority = ctx.accounts.authority.key();
    pool.denomination = denomination;
    pool.next_leaf_index = 0;
    pool.current_root_index = 0;
    pool.is_paused = false;
    pool.bump = ctx.bumps.mixer_pool;

    // Pre-fill every root_history slot with the empty-tree root so
    // is_known_root cannot match an all-zeros root before the ring buffer
    // wraps. (Defense-in-depth — a proof for root=0 already requires
    // breaking Poseidon, but no reason to leave the door propped open.)
    let empty_root = ZERO_HASHES[TREE_LEVELS - 1];
    for slot in pool.root_history.iter_mut() {
        *slot = empty_root;
    }

    // Seed filled_subtrees with the per-level zero hashes so the first
    // (even-index) insertion behaves exactly like a fresh tree.
    for (i, slot) in pool.filled_subtrees.iter_mut().enumerate() {
        *slot = ZERO_HASHES[i];
    }

    msg!("Mixer pool initialized with denomination: {} lamports", denomination);

    Ok(())
}
