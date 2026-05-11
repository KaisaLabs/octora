use anchor_lang::prelude::*;
use crate::constants::{ROOT_HISTORY_SIZE, TREE_LEVELS};

/// Main mixer pool account (also serves as SOL vault).
/// PDA seeds: [b"mixer_pool", denomination.to_le_bytes()]
///
/// Marked `zero_copy` because the struct is ~8.8KB and Anchor's Borsh
/// deserialize generates a 17KB stack frame for `try_deserialize_unchecked`
/// — Solana's SBF stack limit is 4KB, so the previous `#[account]` layout
/// crashed/UB'd at handler entry under load. With zero-copy the handler
/// reads fields directly through a `Ref<MixerPool>` into the account data;
/// no stack allocation of the struct value.
///
/// `is_paused` is `u8` instead of `bool` because `bytemuck::Pod` (which
/// zero_copy requires) rejects `bool` — its bit pattern is not all-valid.
/// Treat 0 = false, non-zero = true via `is_paused_bool()` below.
// `zero_copy(unsafe)`: Anchor's bytemuck::Pod check is too strict for the
// types in this struct (Pubkey doesn't satisfy AnyBitPattern in this
// Anchor version). The `unsafe` variant skips that bound — sound here
// because the struct is `#[repr(C)]` with explicit padding so every byte
// in the account data has a defined layout, no uninitialized memory ever
// escapes, and every field is composed of integer types or byte arrays
// (no enums, no references, no float NaN traps).
#[account(zero_copy(unsafe))]
#[repr(C)]
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

    /// "Filled subtrees" cache for incremental Merkle insertion.
    ///
    /// At each level `i`, this stores the most recently inserted left-side
    /// subtree hash. When the next deposit lands at an odd index at level
    /// `i`, this value is the left sibling for the level-`i` hash; when it
    /// lands at an even index, this slot is overwritten with the new
    /// left-side subtree.
    ///
    /// Together with the precomputed `ZERO_HASHES`, this lets the program
    /// compute the new Merkle root in `TREE_LEVELS` Poseidon syscalls per
    /// deposit, without ever trusting a depositor-supplied root.
    pub filled_subtrees: [[u8; 32]; TREE_LEVELS],

    /// Emergency pause flag — 0 = active, non-zero = paused (bytemuck::Pod
    /// disallows `bool`).
    pub is_paused: u8,

    /// PDA bump seed
    pub bump: u8,

    /// Trailing padding for `#[repr(C)]` alignment to the struct's u64
    /// alignment (8). Without this, the compiler adds an implicit pad
    /// byte after `bump` to round the struct size up to a multiple of 8;
    /// declaring it explicitly keeps the on-chain byte layout
    /// deterministic and matches `SPACE` exactly.
    pub _pad_end: [u8; 6],
}

impl MixerPool {
    /// Field-order matches the prior Borsh layout so layout.ts byte
    /// offsets stay valid:
    ///   8 disc + 32 auth + 8 denom + 4 leaf_idx + 1 root_idx
    ///   + 8192 root_history + 640 filled_subtrees + 1 is_paused
    ///   + 1 bump + 6 _pad_end = 8893
    pub const SPACE: usize =
        8 + 32 + 8 + 4 + 1 + (32 * ROOT_HISTORY_SIZE) + (32 * TREE_LEVELS) + 1 + 1 + 6;

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

    /// Treat the u8 pause flag as a bool. 0 = active, non-zero = paused.
    pub fn is_paused_bool(&self) -> bool {
        self.is_paused != 0
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
