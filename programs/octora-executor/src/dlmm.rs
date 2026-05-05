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
use anchor_lang::solana_program::{hash, instruction::Instruction, program::invoke_signed};

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
