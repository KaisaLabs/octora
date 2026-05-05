use anchor_lang::prelude::*;

/// Meteora DLMM (LB CLMM) program on mainnet & devnet.
///
/// Localnet tests must clone this program via `Anchor.toml`
/// `[[test.validator.clone]]` so the CPI can land somewhere.
pub const DLMM_PROGRAM_ID: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

/// PDA seed for `PositionAuthority`. One position per stealth wallet for now;
/// extend with an index byte if we ever support multiple positions per stealth.
pub const POSITION_AUTHORITY_SEED: &[u8] = b"position-authority";
