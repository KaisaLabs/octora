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
// Mainnet admin = Squads v4 vault PDA: e8ueJb5qHfbGhCmkdLAyK9n1qfYWD9NpqRmEvr9NDTt
pub const EXECUTOR_ADMIN_AUTHORITY: Pubkey = Pubkey::new_from_array([
    0x09, 0x83, 0x6e, 0x5e, 0xc5, 0x6f, 0x94, 0xea,
    0x10, 0x65, 0xb2, 0xf9, 0x45, 0x69, 0xc0, 0x83,
    0x4a, 0xce, 0x23, 0x34, 0x3b, 0x49, 0x08, 0xe5,
    0xa9, 0xe9, 0xd6, 0xaa, 0x63, 0x8e, 0x6c, 0xef,
]);
