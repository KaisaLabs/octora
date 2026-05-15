use anchor_lang::prelude::*;

/// Global executor config — emergency pause + admin authority.
///
/// Mirrors `octora-mixer`'s pause model so that a DLMM CPI bug or
/// upstream Meteora incident can halt every state-mutating instruction
/// from a single multisig signature, without requiring a program upgrade.
///
/// PDA seeds: `[b"config"]` — single global account.
#[account]
pub struct Config {
    /// Key authorized to flip `paused`. Set once at `init_config` and
    /// thereafter only this key can call `set_paused`. Should be a Squads
    /// (or equivalent) multisig PDA on mainnet.
    pub authority: Pubkey,

    /// When true, every state-mutating executor instruction fails closed.
    pub paused: bool,

    /// PDA bump.
    pub bump: u8,
}

impl Config {
    /// Discriminator (8) + authority (32) + paused (1) + bump (1) = 42.
    pub const SPACE: usize = 8 + 32 + 1 + 1;
}
