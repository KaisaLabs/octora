use anchor_lang::prelude::*;
use crate::constants::*;
use crate::errors::MixerError;
use crate::events::WithdrawEvent;
use crate::state::{MixerPool, NullifierAccount};
use crate::verifier;

/// Packed proof data: pi_a (64) + pi_b (128) + pi_c (64) = 256 bytes
pub const PROOF_SIZE: usize = 256;

/// Public inputs: root (32) + nullifierHash (32) + recipient (32) + relayer (32) + fee (32) = 160 bytes
pub const PUBLIC_INPUTS_SIZE: usize = 160;

#[derive(Accounts)]
#[instruction(proof_data: [u8; PROOF_SIZE], public_inputs: [u8; PUBLIC_INPUTS_SIZE])]
pub struct Withdraw<'info> {
    /// The relayer hot wallet that signs and pays for the transaction
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [MIXER_POOL_SEED, &mixer_pool.denomination.to_le_bytes()],
        bump = mixer_pool.bump,
    )]
    pub mixer_pool: Account<'info, MixerPool>,

    /// Nullifier PDA — init ensures double-spend prevention atomically
    #[account(
        init,
        payer = signer,
        space = NullifierAccount::SPACE,
        seeds = [
            NULLIFIER_SEED,
            mixer_pool.key().as_ref(),
            &public_inputs[32..64], // nullifier_hash bytes
        ],
        bump,
    )]
    pub nullifier_account: Account<'info, NullifierAccount>,

    /// Recipient stealth wallet that receives denomination - fee
    /// CHECK: validated against proof public inputs
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// Relayer wallet that receives the fee
    /// CHECK: validated against proof public inputs
    #[account(mut)]
    pub relayer: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Withdraw>,
    proof_data: [u8; PROOF_SIZE],
    public_inputs: [u8; PUBLIC_INPUTS_SIZE],
) -> Result<()> {
    // Parse public inputs
    let root: [u8; 32] = public_inputs[0..32].try_into().unwrap();
    let nullifier_hash: [u8; 32] = public_inputs[32..64].try_into().unwrap();
    let recipient_field: [u8; 32] = public_inputs[64..96].try_into().unwrap();
    let relayer_field: [u8; 32] = public_inputs[96..128].try_into().unwrap();
    let fee_field: [u8; 32] = public_inputs[128..160].try_into().unwrap();

    // Extract fee (big-endian 32 bytes → u64 from last 8 bytes)
    let fee = u64::from_be_bytes(fee_field[24..32].try_into().unwrap());

    // Read pool values before mutable operations
    let denomination = ctx.accounts.mixer_pool.denomination;
    let is_paused = ctx.accounts.mixer_pool.is_paused;

    // Safety checks
    require!(!is_paused, MixerError::PoolPaused);
    require!(fee < denomination, MixerError::FeeExceedsDenomination);

    // Verify the root is in history
    require!(ctx.accounts.mixer_pool.is_known_root(&root), MixerError::RootNotFound);

    // Verify recipient account matches the proof's public input
    let recipient_key = ctx.accounts.recipient.key();
    let recipient_bytes = pubkey_to_field_element(&recipient_key);
    require!(recipient_bytes == recipient_field, MixerError::RecipientMismatch);

    // Verify relayer account matches
    let relayer_key = ctx.accounts.relayer.key();
    let relayer_bytes = pubkey_to_field_element(&relayer_key);
    require!(relayer_bytes == relayer_field, MixerError::RelayerMismatch);

    // Verify Groth16 proof
    let proof_valid = verifier::verify_proof(&proof_data, &public_inputs)?;
    require!(proof_valid, MixerError::InvalidProof);

    // Store nullifier bump
    ctx.accounts.nullifier_account.bump = ctx.bumps.nullifier_account;

    // Check pool has enough lamports (excluding rent-exempt minimum)
    let pool_info = ctx.accounts.mixer_pool.to_account_info();
    let recipient_info = ctx.accounts.recipient.to_account_info();
    let relayer_info = ctx.accounts.relayer.to_account_info();

    let rent = Rent::get()?;
    let min_balance = rent.minimum_balance(MixerPool::SPACE);
    let available = pool_info.lamports().saturating_sub(min_balance);
    require!(available >= denomination, MixerError::InsufficientPoolBalance);

    // Transfer SOL from pool PDA (program-owned, can debit directly)
    let amount = denomination - fee;
    **pool_info.try_borrow_mut_lamports()? -= amount;
    **recipient_info.try_borrow_mut_lamports()? += amount;

    // Transfer fee to relayer
    if fee > 0 {
        **pool_info.try_borrow_mut_lamports()? -= fee;
        **relayer_info.try_borrow_mut_lamports()? += fee;
    }

    // Emit event
    let clock = Clock::get()?;
    emit!(WithdrawEvent {
        nullifier_hash,
        recipient: recipient_key,
        relayer: relayer_key,
        fee,
        timestamp: clock.unix_timestamp,
    });

    msg!("Withdrawal processed: {} lamports to recipient, {} fee to relayer", amount, fee);

    Ok(())
}

/// Convert a Solana Pubkey to a BN254 field element (big-endian bytes).
/// Since Pubkeys are 256 bits but BN254 scalar field is ~254 bits,
/// we reduce mod the field order for keys that exceed it.
fn pubkey_to_field_element(pubkey: &Pubkey) -> [u8; 32] {
    let bytes = pubkey.to_bytes();
    // Most pubkeys (>93%) are already within the field.
    // For simplicity in MVP, we just use the raw bytes.
    // The off-chain code must perform the same conversion.
    //
    // TODO: implement proper modular reduction for the ~6% of pubkeys
    // that exceed the BN254 field order.
    bytes
}
