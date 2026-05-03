use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::constants::*;
use crate::errors::MixerError;
use crate::events::DepositEvent;
use crate::state::{MixerPool, CommitmentAccount};

#[derive(Accounts)]
#[instruction(commitment: [u8; 32])]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [MIXER_POOL_SEED, &mixer_pool.denomination.to_le_bytes()],
        bump = mixer_pool.bump,
    )]
    pub mixer_pool: Account<'info, MixerPool>,

    #[account(
        init,
        payer = depositor,
        space = CommitmentAccount::SPACE,
        seeds = [COMMITMENT_SEED, mixer_pool.key().as_ref(), &commitment],
        bump,
    )]
    pub commitment_account: Account<'info, CommitmentAccount>,

    pub system_program: Program<'info, System>,
}

/// Deposit SOL into the mixer pool.
///
/// The on-chain program stores the commitment and accepts the new Merkle root
/// computed off-chain. The Merkle inclusion proof is verified inside the ZK
/// circuit during withdrawal, not during deposit.
///
/// This design avoids on-chain Poseidon hashing (which exceeds SBF's 4KB stack
/// limit) while maintaining security: an invalid root simply means the
/// depositor's withdrawal proof won't verify later.
pub fn handler(
    ctx: Context<Deposit>,
    commitment: [u8; 32],
    new_root: [u8; 32],
) -> Result<()> {
    // Safety checks
    require!(!ctx.accounts.mixer_pool.is_paused, MixerError::PoolPaused);
    require!(ctx.accounts.mixer_pool.next_leaf_index < MAX_LEAVES, MixerError::TreeFull);

    let denomination = ctx.accounts.mixer_pool.denomination;

    // Transfer denomination from depositor to pool (pool is the vault)
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.mixer_pool.to_account_info(),
            },
        ),
        denomination,
    )?;

    // Store commitment account bump
    ctx.accounts.commitment_account.bump = ctx.bumps.commitment_account;

    // Update pool state
    let pool = &mut ctx.accounts.mixer_pool;
    let leaf_index = pool.next_leaf_index;
    pool.push_root(new_root);
    pool.next_leaf_index += 1;

    // Emit event for off-chain indexing
    let clock = Clock::get()?;
    emit!(DepositEvent {
        commitment,
        leaf_index,
        timestamp: clock.unix_timestamp,
    });

    msg!("Deposit #{} committed", leaf_index);

    Ok(())
}
