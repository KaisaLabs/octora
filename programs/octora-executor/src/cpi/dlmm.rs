//! DLMM-specific CPI builders, layered on shared primitives from `cpi/mod.rs`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use super::{anchor_discriminator, invoke_ix, invoke_signed_ix};
use crate::constants::DLMM_PROGRAM_ID;
use crate::errors::ExecutorError;

pub fn require_dlmm_event_authority(ai: &AccountInfo) -> Result<()> {
    let (expected, _bump) = Pubkey::find_program_address(&[b"__event_authority"], &DLMM_PROGRAM_ID);
    require_keys_eq!(
        ai.key(),
        expected,
        ExecutorError::DlmmEventAuthorityMismatch
    );
    Ok(())
}

pub fn require_dlmm_program(ai: &AccountInfo) -> Result<()> {
    require_keys_eq!(
        ai.key(),
        DLMM_PROGRAM_ID,
        ExecutorError::DlmmProgramMismatch
    );
    Ok(())
}

/// Build a DLMM CPI instruction. Uses `DLMM_PROGRAM_ID` as program_id.
pub fn build_dlmm_ix(
    ix_name: &str,
    accounts: Vec<AccountMeta>,
    args_bytes: Vec<u8>,
) -> anchor_lang::solana_program::instruction::Instruction {
    let mut data = Vec::with_capacity(8 + args_bytes.len());
    data.extend_from_slice(&anchor_discriminator(ix_name));
    data.extend_from_slice(&args_bytes);

    anchor_lang::solana_program::instruction::Instruction {
        program_id: DLMM_PROGRAM_ID,
        accounts,
        data,
    }
}

/// Invoke a DLMM CPI with PDA signer seeds.
pub fn invoke_dlmm_signed(
    ix: &anchor_lang::solana_program::instruction::Instruction,
    account_infos: &[AccountInfo],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    invoke_signed_ix(ix, account_infos, signer_seeds)
}

/// Invoke a DLMM CPI without PDA signer seeds. Used for `swap_via_dlmm` where
/// the only signer is the stealth wallet — already authorized by the outer tx.
pub fn invoke_dlmm(
    ix: &anchor_lang::solana_program::instruction::Instruction,
    account_infos: &[AccountInfo],
) -> Result<()> {
    invoke_ix(ix, account_infos)
}
