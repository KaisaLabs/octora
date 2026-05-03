use anchor_lang::prelude::*;
use crate::constants::ROOT_HISTORY_SIZE;

/// Main mixer pool account (also serves as SOL vault).
/// PDA seeds: [b"mixer_pool", denomination.to_le_bytes()]
#[account]
pub struct MixerPool {
    /// Admin authority who can pause/unpause the pool
    pub authority: Pubkey,

    /// Fixed deposit denomination in lamports (e.g., 1 SOL = 1_000_000_000)
    pub denomination: u64,

    /// Next available leaf index in the Merkle tree
    pub next_leaf_index: u32,

    /// Current index into the root_history ring buffer
    pub current_root_index: u8,

    /// Ring buffer of recent valid Merkle roots
    pub root_history: [[u8; 32]; ROOT_HISTORY_SIZE],

    /// Emergency pause flag
    pub is_paused: bool,

    /// PDA bump seed
    pub bump: u8,
}

impl MixerPool {
    /// Account discriminator (8) + authority (32) + denomination (8) +
    /// next_leaf_index (4) + current_root_index (1) +
    /// root_history (32 * 30 = 960) + is_paused (1) + bump (1) = 1015
    pub const SPACE: usize = 8 + 32 + 8 + 4 + 1 + (32 * ROOT_HISTORY_SIZE) + 1 + 1;

    /// Check if a root exists in the history ring buffer
    pub fn is_known_root(&self, root: &[u8; 32]) -> bool {
        self.root_history.iter().any(|r| r == root)
    }

    /// Push a new root into the ring buffer
    pub fn push_root(&mut self, root: [u8; 32]) {
        self.current_root_index = ((self.current_root_index as usize + 1) % ROOT_HISTORY_SIZE) as u8;
        self.root_history[self.current_root_index as usize] = root;
    }

    /// Get the current (latest) root
    pub fn current_root(&self) -> &[u8; 32] {
        &self.root_history[self.current_root_index as usize]
    }
}

/// Nullifier account - its existence proves the nullifier has been spent.
/// PDA seeds: [b"nullifier", mixer_pool.key(), nullifier_hash]
#[account]
pub struct NullifierAccount {
    pub bump: u8,
}

impl NullifierAccount {
    /// Account discriminator (8) + bump (1) = 9
    pub const SPACE: usize = 8 + 1;
}

/// Commitment account - its existence proves the commitment has been deposited.
/// PDA seeds: [b"commitment", mixer_pool.key(), commitment]
#[account]
pub struct CommitmentAccount {
    pub bump: u8,
}

impl CommitmentAccount {
    /// Account discriminator (8) + bump (1) = 9
    pub const SPACE: usize = 8 + 1;
}
