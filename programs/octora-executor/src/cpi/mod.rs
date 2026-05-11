use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::Instruction,
    program::{invoke, invoke_signed},
    system_program, sysvar,
};

pub mod dlmm;

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
    // Defense-in-depth (audit P3-NEW-B): a real sysvar account is never a
    // signer and never executable. Asserting both flags blocks the
    // "spoofed-account-claiming-to-be-rent" substitution pattern even if
    // the key check is somehow weakened in the future.
    require!(!ai.is_signer, ExecutorError::InvalidSysAccount);
    require!(!ai.executable, ExecutorError::InvalidSysAccount);
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

/// Plain CPI invoke (no PDA signers). Used by instructions whose only signer
/// is the stealth wallet — the outer tx already carries that signature.
pub fn invoke_ix(ix: &Instruction, account_infos: &[AccountInfo]) -> Result<()> {
    invoke(ix, account_infos).map_err(Into::into)
}

/// Read the `amount` field (bytes 64..72) of an SPL Token / Token-2022 token
/// account. Used for balance-delta slippage enforcement around CPIs whose
/// internal `min_out` we don't fully trust.
pub fn read_token_account_amount(token_account: &AccountInfo) -> Result<u64> {
    let data = token_account.try_borrow_data()?;
    require!(data.len() >= 165, ExecutorError::InvalidTokenAccount);
    let amount_bytes: [u8; 8] = data[64..72].try_into().unwrap();
    Ok(u64::from_le_bytes(amount_bytes))
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
