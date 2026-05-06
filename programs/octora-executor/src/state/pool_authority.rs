use anchor_lang::prelude::*;

/// Identifies which pool type a PoolAuthority references.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum PoolRef {
    Dlmm {
        lb_pair: Pubkey,
        position: Pubkey,
    },
    Damm {
        pool: Pubkey,
        lp_mint: Pubkey,
        lock_escrow: Pubkey,
    },
}

impl PoolRef {
    pub fn max_serialized_size() -> usize {
        1 + 32 + 32 + 32
    }

    pub fn pool_key(&self) -> Pubkey {
        match self {
            PoolRef::Dlmm { lb_pair, .. } => *lb_pair,
            PoolRef::Damm { pool, .. } => *pool,
        }
    }
}

/// PDA that owns a pool position on behalf of a stealth wallet.
///
/// Works for both DLMM and DAMM pools. The PDA is derived from
/// [POOL_AUTHORITY_SEED, stealth_pubkey, pool_pubkey].
#[account]
pub struct PoolAuthority {
    pub stealth_pubkey: Pubkey,
    pub exit_recipient: Pubkey,
    pub pool_ref: PoolRef,
    pub bump: u8,
}

impl PoolAuthority {
    pub const SPACE: usize = 8 + 32 + 32 + 97 + 1;
}
