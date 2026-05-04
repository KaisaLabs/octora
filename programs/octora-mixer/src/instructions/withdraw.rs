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
/// Reduces mod the BN254 scalar field order so it matches what the
/// ZK circuit does internally (all field elements are auto-reduced).
///
/// Pubkeys are 256 bits but the field is ~254 bits, so values can be
/// up to ~4x the field order. We subtract R repeatedly until in range.
fn pubkey_to_field_element(pubkey: &Pubkey) -> [u8; 32] {
    let mut bytes = pubkey.to_bytes();

    // BN254 scalar field order r (big-endian)
    const R: [u8; 32] = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
        0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
        0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
        0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
    ];

    // Subtract R until bytes < R (at most 3 iterations since max pubkey < 4*R)
    while ge_be(&bytes, &R) {
        bytes = sub_be(&bytes, &R);
    }

    bytes
}

/// Big-endian comparison: a >= b
fn ge_be(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in 0..32 {
        if a[i] > b[i] {
            return true;
        } else if a[i] < b[i] {
            return false;
        }
    }
    true // equal
}

/// Big-endian subtraction: a - b (assumes a >= b)
fn sub_be(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut result = [0u8; 32];
    let mut borrow: i16 = 0;
    for i in (0..32).rev() {
        let diff = a[i] as i16 - b[i] as i16 - borrow;
        if diff < 0 {
            result[i] = (diff + 256) as u8;
            borrow = 1;
        } else {
            result[i] = diff as u8;
            borrow = 0;
        }
    }
    result
}
