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

pub fn handler(
    ctx: Context<Deposit>,
    commitment: [u8; 32],
    proof_siblings: [[u8; 32]; TREE_LEVELS],
) -> Result<()> {
    // Safety checks
    require!(!ctx.accounts.mixer_pool.is_paused, MixerError::PoolPaused);
    require!(ctx.accounts.mixer_pool.next_leaf_index < MAX_LEAVES, MixerError::TreeFull);

    // Read values before mutable borrow
    let denomination = ctx.accounts.mixer_pool.denomination;
    let current_root = *ctx.accounts.mixer_pool.current_root();
    let leaf_index = ctx.accounts.mixer_pool.next_leaf_index;

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

    // Verify old root and compute new root using Poseidon Merkle path
    let new_root = compute_new_root(
        &commitment,
        &proof_siblings,
        leaf_index,
        &current_root,
    )?;

    // Store commitment account bump
    ctx.accounts.commitment_account.bump = ctx.bumps.commitment_account;

    // Update pool state
    let pool = &mut ctx.accounts.mixer_pool;
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

/// Verify the Merkle proof against the current root, then compute the new root
/// after inserting the commitment at the given leaf index.
///
/// 1. Derive path indices from leaf_index (binary decomposition)
/// 2. Hash upward from ZERO_VALUE using siblings → must equal current_root
/// 3. Hash upward from commitment using siblings → new_root
fn compute_new_root(
    commitment: &[u8; 32],
    siblings: &[[u8; 32]; TREE_LEVELS],
    leaf_index: u32,
    current_root: &[u8; 32],
) -> Result<[u8; 32]> {
    use light_poseidon::Poseidon;

    let mut poseidon = Poseidon::<ark_bn254::Fr>::new_circom(2)
        .map_err(|_| error!(MixerError::InvalidMerkleProof))?;

    // Verify old root: hash upward from zero value
    let mut old_hash = ZERO_VALUE;
    let mut new_hash = *commitment;

    for level in 0..TREE_LEVELS {
        let is_right = (leaf_index >> level) & 1 == 1;

        if is_right {
            old_hash = poseidon_hash_pair(&mut poseidon, &siblings[level], &old_hash)?;
            new_hash = poseidon_hash_pair(&mut poseidon, &siblings[level], &new_hash)?;
        } else {
            old_hash = poseidon_hash_pair(&mut poseidon, &old_hash, &siblings[level])?;
            new_hash = poseidon_hash_pair(&mut poseidon, &new_hash, &siblings[level])?;
        }
    }

    // Verify the old root matches
    require!(old_hash == *current_root, MixerError::InvalidMerkleProof);

    Ok(new_hash)
}

/// Hash two 32-byte inputs using Poseidon
fn poseidon_hash_pair(
    poseidon: &mut light_poseidon::Poseidon<ark_bn254::Fr>,
    left: &[u8; 32],
    right: &[u8; 32],
) -> Result<[u8; 32]> {
    use light_poseidon::PoseidonBytesHasher;

    let result = poseidon
        .hash_bytes_be(&[left, right])
        .map_err(|_| error!(MixerError::InvalidMerkleProof))?;

    Ok(result)
}
