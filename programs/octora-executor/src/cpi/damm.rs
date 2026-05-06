//! DAMM-specific CPI helpers.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::{DAMM_PROGRAM_ID, LOCK_ESCROW_SEED};
use crate::errors::ExecutorError;

pub const VAULT_PROGRAM_ID: Pubkey = pubkey!("HWzXGcGHy4tcpYfaRDCyLNzXqBTv3E6BttpCH2vJxArv");

/// Derive DAMM lock escrow PDA: [LOCK_ESCROW_SEED, pool, owner]
pub fn derive_lock_escrow(pool: &Pubkey, owner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[LOCK_ESCROW_SEED, pool.as_ref(), owner.as_ref()],
        &DAMM_PROGRAM_ID,
    )
}

pub fn require_damm_program(ai: &AccountInfo) -> Result<()> {
    require_keys_eq!(
        ai.key(),
        DAMM_PROGRAM_ID,
        ExecutorError::DammProgramMismatch
    );
    Ok(())
}

pub fn build_damm_ix(
    ix_name: &str,
    accounts: Vec<AccountMeta>,
    args_bytes: Vec<u8>,
) -> anchor_lang::solana_program::instruction::Instruction {
    let discriminator = anchor_discriminator_for_damm(ix_name);
    let mut data = Vec::with_capacity(8 + args_bytes.len());
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(&args_bytes);

    anchor_lang::solana_program::instruction::Instruction {
        program_id: DAMM_PROGRAM_ID,
        accounts,
        data,
    }
}

pub fn invoke_damm_signed(
    ix: &anchor_lang::solana_program::instruction::Instruction,
    account_infos: &[AccountInfo],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    anchor_lang::solana_program::program::invoke_signed(ix, account_infos, signer_seeds)
        .map_err(Into::into)
}

/// Compute DAMM instruction discriminator: sha256("global:<name>")[..8].
fn anchor_discriminator_for_damm(ix_name: &str) -> [u8; 8] {
    let preimage = format!("global:{}", ix_name);
    let digest = anchor_lang::solana_program::hash::hash(preimage.as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest.to_bytes()[..8]);
    out
}

/// Serialize addBalanceLiquidity args: (pool_token_amount: u64, max_token_a: u64, max_token_b: u64)
pub fn serialize_add_balance_liquidity_args(
    pool_token_amount: u64,
    max_token_a: u64,
    max_token_b: u64,
) -> Vec<u8> {
    let mut args = Vec::with_capacity(24);
    args.extend_from_slice(&pool_token_amount.to_le_bytes());
    args.extend_from_slice(&max_token_a.to_le_bytes());
    args.extend_from_slice(&max_token_b.to_le_bytes());
    args
}

/// Serialize removeBalanceLiquidity args: (pool_token_amount: u64, min_token_a_out: u64, min_token_b_out: u64)
pub fn serialize_remove_balance_liquidity_args(
    pool_token_amount: u64,
    min_token_a_out: u64,
    min_token_b_out: u64,
) -> Vec<u8> {
    let mut args = Vec::with_capacity(24);
    args.extend_from_slice(&pool_token_amount.to_le_bytes());
    args.extend_from_slice(&min_token_a_out.to_le_bytes());
    args.extend_from_slice(&min_token_b_out.to_le_bytes());
    args
}
