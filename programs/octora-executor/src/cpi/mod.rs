use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::Instruction, program::invoke_signed, system_program, sysvar,
};

pub mod damm;
pub mod dlmm;

pub use damm::*;
pub use dlmm::*;

use crate::errors::ExecutorError;

// ── Token program IDs ──
pub const SPL_TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SPL_TOKEN_2022_PROGRAM_ID: Pubkey =
    pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// ── Validators ──
pub fn require_spl_token_program(ai: &AccountInfo) -> Result<()> {
    let k = ai.key();
    require!(
        k == SPL_TOKEN_PROGRAM_ID || k == SPL_TOKEN_2022_PROGRAM_ID,
        ExecutorError::InvalidTokenProgram
    );
    Ok(())
}

pub fn require_system_program(ai: &AccountInfo) -> Result<()> {
    require_keys_eq!(
        ai.key(),
        system_program::ID,
        ExecutorError::InvalidSysAccount
    );
    Ok(())
}

pub fn require_rent_sysvar(ai: &AccountInfo) -> Result<()> {
    require_keys_eq!(ai.key(), sysvar::rent::ID, ExecutorError::InvalidSysAccount);
    Ok(())
}

/// Validate SPL token account owner matches expected.
/// Reads raw bytes at offset 32 (compatible with both SPL Token and Token-2022).
pub fn require_token_account_owner(token_account: &AccountInfo, expected: &Pubkey) -> Result<()> {
    let data = token_account.try_borrow_data()?;
    require!(data.len() >= 165, ExecutorError::InvalidTokenAccount);
    let owner_bytes: [u8; 32] = data[32..64].try_into().unwrap();
    let owner = Pubkey::new_from_array(owner_bytes);
    require_keys_eq!(owner, *expected, ExecutorError::ExitRecipientMismatch);
    Ok(())
}

// ── Shared helpers ──
pub fn anchor_discriminator(ix_name: &str) -> [u8; 8] {
    let preimage = format!("global:{}", ix_name);
    let digest = solana_sha256_hasher::hash(preimage.as_bytes());
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

/// Validate a token account's mint matches the expected mint.
/// Token account layout: mint is at bytes 0-32.
pub fn require_token_account_mint(
    token_account: &AccountInfo,
    _token_program: &AccountInfo,
    expected_mint: &Pubkey,
) -> Result<()> {
    let data = token_account.try_borrow_data()?;
    require!(data.len() >= 165, ExecutorError::InvalidTokenAccount);
    let mint_bytes: [u8; 32] = data[0..32].try_into().unwrap();
    let mint = Pubkey::new_from_array(mint_bytes);
    require_keys_eq!(mint, *expected_mint, ExecutorError::InvalidTokenAccount);
    Ok(())
}
