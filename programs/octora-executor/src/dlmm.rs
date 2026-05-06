//! Raw CPI helpers for Meteora DLMM (lb_clmm).
//!
//! We don't statically depend on Meteora's crate to avoid version conflicts
//! (their pinned `solana-program` may drift from ours). Instead we forward
//! the caller-supplied account list to DLMM and serialise the instruction
//! data ourselves: 8-byte Anchor discriminator + Borsh-encoded args.
//!
//! Account ordering and arg layouts are caller-driven: the instruction
//! handler in `instructions/*.rs` is the single point where DLMM's expected
//! account list is encoded. That keeps the contract with Meteora visible in
//! one place per ix and easy to update when their IDL changes.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    hash,
    instruction::Instruction,
    program::invoke_signed,
    system_program,
    sysvar,
};
use anchor_spl::token::spl_token::state::Account as SplTokenAccount;
use anchor_lang::solana_program::program_pack::Pack;

use crate::constants::DLMM_PROGRAM_ID;
use crate::errors::ExecutorError;

/// Canonical SPL Token program ID. Hardcoded so a forwarded `token_program`
/// account cannot be silently substituted with an attacker-controlled program.
pub const SPL_TOKEN_PROGRAM_ID: Pubkey =
    pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/// Canonical Token-2022 program ID. Same rationale as `SPL_TOKEN_PROGRAM_ID`.
pub const SPL_TOKEN_2022_PROGRAM_ID: Pubkey =
    pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// Reject anything other than the SPL Token or Token-2022 program. DLMM
/// invokes the forwarded token_program internally; without this guard a
/// caller could swap in a program that signs with our PDA's authority on
/// behalf of DLMM's internal CPIs.
pub fn require_spl_token_program(ai: &AccountInfo) -> Result<()> {
    let k = ai.key();
    require!(
        k == SPL_TOKEN_PROGRAM_ID || k == SPL_TOKEN_2022_PROGRAM_ID,
        ExecutorError::InvalidTokenProgram,
    );
    Ok(())
}

/// Reject anything other than the System program at the given slot.
pub fn require_system_program(ai: &AccountInfo) -> Result<()> {
    require_keys_eq!(ai.key(), system_program::ID, ExecutorError::InvalidSysAccount);
    Ok(())
}

/// Reject anything other than the Rent sysvar at the given slot.
pub fn require_rent_sysvar(ai: &AccountInfo) -> Result<()> {
    require_keys_eq!(ai.key(), sysvar::rent::ID, ExecutorError::InvalidSysAccount);
    Ok(())
}

/// Cached derivation of DLMM's `event_authority` PDA — `[b"__event_authority"]`
/// under `DLMM_PROGRAM_ID`. We re-derive on each call (find_program_address
/// isn't const). Costs a few k CU per ix; in exchange we get a hard canary
/// that fires the moment DLMM's IDL drifts.
pub fn require_dlmm_event_authority(ai: &AccountInfo) -> Result<()> {
    let (expected, _bump) =
        Pubkey::find_program_address(&[b"__event_authority"], &DLMM_PROGRAM_ID);
    require_keys_eq!(ai.key(), expected, ExecutorError::EventAuthorityMismatch);
    Ok(())
}

/// Reject anything other than the DLMM program at the trailing program slot.
pub fn require_dlmm_program(ai: &AccountInfo) -> Result<()> {
    require_keys_eq!(ai.key(), DLMM_PROGRAM_ID, ExecutorError::DlmmProgramMismatch);
    Ok(())
}

/// Verify that an SPL token account's `owner` matches `expected`. Used to
/// pin claim/withdraw destinations to `PositionAuthority.exit_recipient`.
pub fn require_token_account_owner(
    token_account: &AccountInfo,
    expected: &Pubkey,
) -> Result<()> {
    let data = token_account.try_borrow_data()?;
    let parsed = SplTokenAccount::unpack(&data)
        .map_err(|_| error!(ExecutorError::InvalidTokenAccount))?;
    require_keys_eq!(parsed.owner, *expected, ExecutorError::ExitRecipientMismatch);
    Ok(())
}

/// Compute an Anchor instruction discriminator: `sha256("global:<name>")[..8]`.
pub fn anchor_discriminator(ix_name: &str) -> [u8; 8] {
    let preimage = format!("global:{}", ix_name);
    let digest = hash::hash(preimage.as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest.to_bytes()[..8]);
    out
}

/// Build a CPI `Instruction` for a DLMM call.
///
/// `args_bytes` is the Borsh-encoded argument tuple expected by the target
/// instruction (excluding the discriminator — we prepend it).
pub fn build_dlmm_ix(
    dlmm_program_id: Pubkey,
    ix_name: &str,
    accounts: Vec<anchor_lang::solana_program::instruction::AccountMeta>,
    args_bytes: Vec<u8>,
) -> Instruction {
    let mut data = Vec::with_capacity(8 + args_bytes.len());
    data.extend_from_slice(&anchor_discriminator(ix_name));
    data.extend_from_slice(&args_bytes);

    Instruction {
        program_id: dlmm_program_id,
        accounts,
        data,
    }
}

/// Invoke a DLMM instruction with the `PositionAuthority` PDA as one of the
/// signers. `signer_seeds` is the seed slice for that PDA.
pub fn invoke_dlmm_signed(
    ix: &Instruction,
    account_infos: &[AccountInfo],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    invoke_signed(ix, account_infos, signer_seeds).map_err(Into::into)
}
