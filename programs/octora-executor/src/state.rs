use anchor_lang::prelude::*;

/// PDA that owns a Meteora DLMM position on behalf of a stealth wallet.
///
/// The PDA is the position's `owner` field as far as Meteora is concerned;
/// only this program can sign for it, and only when the outer instruction
/// is signed by the matching `stealth_pubkey`.
#[account]
pub struct PositionAuthority {
    /// Stealth wallet that authorises actions against this position.
    pub stealth_pubkey: Pubkey,

    /// Meteora `LbPair` this position is opened against.
    pub lb_pair: Pubkey,

    /// Meteora `Position` account owned by this PDA.
    pub position: Pubkey,

    /// PDA bump for `[POSITION_AUTHORITY_SEED, stealth_pubkey]`.
    pub bump: u8,
}

impl PositionAuthority {
    pub const SPACE: usize = 8 // discriminator
        + 32  // stealth_pubkey
        + 32  // lb_pair
        + 32  // position
        + 1;  // bump
}
