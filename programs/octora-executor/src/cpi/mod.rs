use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    hash, instruction::Instruction, program::invoke_signed, system_program, sysvar,
};
use anchor_spl::token::spl_token::state::Account as SplTokenAccount;
use anchor_lang::solana_program::program_pack::Pack;

pub mod damm;
pub mod dlmm;

pub use damm::*;
pub use dlmm::*;

use crate::errors::ExecutorError;

// ── Token program IDs ──
pub const SPL_TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SPL_TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// ── Validators ──
pub fn require_spl_token_program(ai: &AccountInfo) -> Result<()> {
    let k = ai.key();
    require!(
        k == SPL_TOKEN_PROGRAM_ID || k == SPL_TOKEN_2022_PROGRAM_ID,
        ExecutorError::InvalidTokenProgram,
    );
    Ok(())
}

pub fn require_system_program(ai: &AccountInfo) -> Result<()> {
    require_keys_eq!(ai.key(), system_program::ID, ExecutorError::InvalidSysAccount);
    Ok(())
}

pub fn require_rent_sysvar(ai: &AccountInfo) -> Result<()> {
    require_keys_eq!(ai.key(), sysvar::rent::ID, ExecutorError::InvalidSysAccount);
    Ok(())
}

/// Validate SPL token account owner matches expected.
/// Uses sized deserialization compatible with both SPL Token and Token-2022.
pub fn require_token_account_owner(
    token_account: &AccountInfo,
    expected: &Pubkey,
) -> Result<()> {
    let data = token_account.try_borrow_data()?;
    require!(data.len() >= 165, ExecutorError::InvalidTokenAccount);

    // owner is at bytes 32-64 in the SplTokenAccount layout (common for both
    // SPL Token and Token-2022).  Read raw bytes to avoid Pack::unpack issues
    // with extension accounts.
    let owner_bytes: [u8; 32] = data[32..64].try_into().unwrap();
    let owner = Pubkey::new_from_array(owner_bytes);
    require_keys_eq!(owner, *expected, ExecutorError::ExitRecipientMismatch);
    Ok(())
}

// ── Shared helpers ──
pub fn anchor_discriminator(ix_name: &str) -> [u8; 8] {
    let preimage = format!("global:{}", ix_name);
    let digest = hash::hash(preimage.as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest.to_bytes()[..8]);
    out
}

pub fn invoke_signed_ix(
    ix: &Instruction,
    account_infos: &[AccountInfo],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    invoke_signed(ix, account_infos, signer_seeds).map_err(Into::into)
}
