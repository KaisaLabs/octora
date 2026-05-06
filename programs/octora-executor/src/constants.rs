use anchor_lang::prelude::*;

/// Meteora DLMM (LB CLMM) program on mainnet & devnet.
pub const DLMM_PROGRAM_ID: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

/// Meteora DAMM (Dynamic AMM) program on mainnet & devnet.
pub const DAMM_PROGRAM_ID: Pubkey = pubkey!("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB");

/// Vault base key for DAMM.
pub const VAULT_BASE_KEY: Pubkey = pubkey!("HWzXGcGHy4tcpYfaRDCyLNzXqBTv3E6BttpCH2vJxArv");

/// PDA seed for PoolAuthority — derived from [POOL_AUTHORITY_SEED, stealth_pubkey, pool_pubkey].
pub const POOL_AUTHORITY_SEED: &[u8] = b"pool-authority";

/// DAMM lock escrow seed prefix: [LOCK_ESCROW_SEED, pool, owner].
pub const LOCK_ESCROW_SEED: &[u8] = b"lock_escrow";
