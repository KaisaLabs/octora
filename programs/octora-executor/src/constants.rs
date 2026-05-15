use anchor_lang::prelude::*;

/// Meteora DLMM (LB CLMM) program on mainnet & devnet.
pub const DLMM_PROGRAM_ID: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

/// Octora mixer program. Compound instructions validate this account before
/// failing closed on the currently unsupported cross-program primitive.
pub const MIXER_PROGRAM_ID: Pubkey = pubkey!("BHxT3jyWJ1mRLyMjywQoiSXBqo7YpTiGWC1oVr2Ppnzx");

/// PDA seed for PoolAuthority — derived from [POOL_AUTHORITY_SEED, stealth_pubkey, pool_pubkey].
pub const POOL_AUTHORITY_SEED: &[u8] = b"pool-authority";

/// PDA seed for the global executor `Config` account: `[CONFIG_SEED]`.
pub const CONFIG_SEED: &[u8] = b"config";

/// Admin pubkey allowed to call `init_config` and become the pause authority.
///
/// **REPLACE this with the deployer multisig / Squads PDA before mainnet.**
/// `Config.authority` is set from the signer of `init_config` and is the
/// only key allowed to toggle `paused` thereafter — losing or front-running
/// this key is unrecoverable.
///
/// To bypass the address constraint on devnet/local builds, compile with
/// `--features permissionless-init` (see `instructions/admin.rs`).
///
/// The placeholder below is a clearly fake byte pattern. On mainnet, every
/// `init_config` will fail-closed until this is overwritten. That is
/// intentional.
pub const EXECUTOR_ADMIN_AUTHORITY: Pubkey = Pubkey::new_from_array([
    0x4f, 0x43, 0x54, 0x4f, 0x52, 0x41, 0x5f, 0x45, 0x58, 0x45, 0x43, 0x55, 0x54, 0x4f, 0x52, 0x5f,
    0x41, 0x44, 0x4d, 0x49, 0x4e, 0x5f, 0x50, 0x4c, 0x41, 0x43, 0x45, 0x48, 0x4f, 0x4c, 0x44, 0x21,
]);
