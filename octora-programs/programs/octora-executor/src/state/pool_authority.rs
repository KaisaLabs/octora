use anchor_lang::prelude::*;

/// Identifies which pool type a PoolAuthority references.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum PoolRef {
    Dlmm {
        lb_pair: Pubkey,
        position: Pubkey,
    },
}

impl PoolRef {
    pub fn max_serialized_size() -> usize {
        1 + 32 + 32
    }

    pub fn pool_key(&self) -> Pubkey {
        let PoolRef::Dlmm { lb_pair, .. } = self;
        *lb_pair
    }
}

/// PDA that owns a DLMM pool position on behalf of a stealth wallet.
/// Derived from [POOL_AUTHORITY_SEED, stealth_pubkey, lb_pair_pubkey].
#[account]
pub struct PoolAuthority {
    pub stealth_pubkey: Pubkey,
    pub exit_recipient: Pubkey,
    pub pool_ref: PoolRef,
    pub bump: u8,
}

impl PoolAuthority {
    pub const SPACE: usize = 8 + 32 + 32 + 65 + 1;
}
