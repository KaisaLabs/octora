use anchor_lang::prelude::*;

#[event]
pub struct DepositEvent {
    pub commitment: [u8; 32],
    pub leaf_index: u32,
    pub timestamp: i64,
}

#[event]
pub struct WithdrawEvent {
    pub nullifier_hash: [u8; 32],
    pub recipient: Pubkey,
    pub relayer: Pubkey,
    pub fee: u64,
    pub timestamp: i64,
}

/// Emitted whenever the pool's pause flag is toggled. Off-chain monitors
/// (status pages, alerting) subscribe to this to surface admin actions.
#[event]
pub struct PausedEvent {
    pub denomination: u64,
    pub paused: bool,
    pub authority: Pubkey,
    pub timestamp: i64,
}
