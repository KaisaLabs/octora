use anchor_lang::prelude::*;
use anchor_lang::solana_program::poseidon::{hashv, Endianness, Parameters};
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

    // Boxed: see Initialize for the rationale (MixerPool is ~1.6KB after
    // adding filled_subtrees and would overflow the SBF stack otherwise).
    #[account(
        mut,
        seeds = [MIXER_POOL_SEED, &mixer_pool.denomination.to_le_bytes()],
        bump = mixer_pool.bump,
    )]
    pub mixer_pool: Box<Account<'info, MixerPool>>,

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
/// The on-chain program computes the new Merkle root deterministically from
/// the previous tree state (filled_subtrees + zero hashes) using the Solana
/// Poseidon syscall. This closes the audit's HIGH finding that any depositor
/// could push an arbitrary `new_root` into the ring buffer and grief other
/// users by evicting their roots before they can withdraw.
///
/// The new root is now provably consistent with the deposit history.
pub fn handler(
    ctx: Context<Deposit>,
    commitment: [u8; 32],
) -> Result<()> {
    // Safety checks (read state before mutable borrow)
    require!(!ctx.accounts.mixer_pool.is_paused, MixerError::PoolPaused);
    require!(
        ctx.accounts.mixer_pool.next_leaf_index < MAX_LEAVES,
        MixerError::TreeFull,
    );

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

    // ── Tornado-style incremental Merkle insertion ──
    //
    // Walk the tree from leaf to root, hashing the commitment up alongside
    // the existing siblings (cached filled_subtrees on the left, zero
    // hashes on the right). At each even-index level, this insertion's
    // hash becomes the new filled_subtrees[level] for future inserts.
    //
    // Cost: TREE_LEVELS Poseidon syscalls per deposit. The tx must request
    // a higher compute budget — see the off-chain client.
    let pool = &mut ctx.accounts.mixer_pool;
    let leaf_index = pool.next_leaf_index;

    let mut current_hash = commitment;
    let mut current_index = leaf_index;
    for i in 0..TREE_LEVELS {
        // Empty-sibling at level `i`:
        //   - At level 0 the sibling is an empty LEAF — the bare zero value.
        //   - At level i>0 the sibling is the empty *subtree* hash at level i,
        //     which is ZERO_HASHES[i-1] under our existing zero-hash table
        //     (ZERO_HASHES[k] = poseidon^(k+1)(0,0) = empty subtree hash at
        //     level k+1). Off-chain `fixed-merkle-tree` uses the same shape
        //     (its _zeros[0] == 0 and _zeros[i] = hash(_zeros[i-1], _zeros[i-1])).
        let zero_sibling = if i == 0 { ZERO_VALUE } else { ZERO_HASHES[i - 1] };

        let (left, right) = if current_index & 1 == 0 {
            // current node is the left child; right sibling is empty at this level
            pool.filled_subtrees[i] = current_hash;
            (current_hash, zero_sibling)
        } else {
            // current node is the right child; left sibling is the cached subtree
            (pool.filled_subtrees[i], current_hash)
        };

        let hash = hashv(
            Parameters::Bn254X5,
            Endianness::BigEndian,
            &[&left, &right],
        )
        .map_err(|_| error!(MixerError::PoseidonHashFailed))?;
        current_hash = hash.to_bytes();

        current_index >>= 1;
    }
    let new_root = current_hash;

    pool.push_root(new_root);
    pool.next_leaf_index = leaf_index + 1;

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
