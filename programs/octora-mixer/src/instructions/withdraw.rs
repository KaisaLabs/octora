use anchor_lang::prelude::*;
use anchor_lang::solana_program::poseidon::{hashv, Endianness, Parameters};
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

    // Boxed: see Initialize for the rationale (MixerPool is ~1.6KB after
    // adding filled_subtrees, and withdraw's try_accounts also carries the
    // 256+160 byte instruction args, so this struct overflowed worst).
    #[account(
        mut,
        seeds = [MIXER_POOL_SEED, &mixer_pool.denomination.to_le_bytes()],
        bump = mixer_pool.bump,
    )]
    pub mixer_pool: Box<Account<'info, MixerPool>>,

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

    // Reject any public input >= BN254 scalar field order.
    //
    // groth16-solana 0.2.x does not enforce range on public inputs, so
    // without this check a verifying proof could be re-submitted with
    // public_inputs that are equivalent mod r but byte-distinct. The
    // nullifier PDA seeds use raw bytes, so equivalent-mod-r encodings
    // would produce different PDAs — i.e. nullifier replay.
    require_lt_field_order(&root)?;
    require_lt_field_order(&nullifier_hash)?;
    require_lt_field_order(&recipient_field)?;
    require_lt_field_order(&relayer_field)?;
    require_lt_field_order(&fee_field)?;

    // Extract fee (big-endian 32 bytes → u64 from last 8 bytes).
    // The circuit binds the full field element, so reject any proof whose fee
    // doesn't fit in u64 — otherwise the upper 24 bytes are silently dropped
    // and the on-chain enforcement diverges from what the circuit guarantees.
    require!(
        fee_field[0..24].iter().all(|&b| b == 0),
        MixerError::FeeOverflow,
    );
    let fee = u64::from_be_bytes(fee_field[24..32].try_into().unwrap());

    // Read pool values before mutable operations
    let denomination = ctx.accounts.mixer_pool.denomination;
    let is_paused = ctx.accounts.mixer_pool.is_paused;

    // Safety checks
    require!(!is_paused, MixerError::PoolPaused);
    require!(fee < denomination, MixerError::FeeExceedsDenomination);

    // Verify the root is in history
    require!(ctx.accounts.mixer_pool.is_known_root(&root), MixerError::RootNotFound);

    // Reject recipient/relayer aliasing the pool. Aliasing is harmless to
    // the protocol (the user just burns their deposit) but is almost
    // always a client mistake — fail loudly rather than silently consume
    // the deposit.
    let pool_key = ctx.accounts.mixer_pool.key();
    require_keys_neq!(
        ctx.accounts.recipient.key(),
        pool_key,
        MixerError::RecipientAliasesPool,
    );
    require_keys_neq!(
        ctx.accounts.relayer.key(),
        pool_key,
        MixerError::RecipientAliasesPool,
    );

    // Verify recipient account matches the proof's public input.
    //
    // We bind the recipient via Poseidon(hi, lo) where (hi, lo) are the
    // two 16-byte halves of pubkey.to_bytes(). The previous design used
    // `pubkey mod r` which has a collision class of ~4 distinct pubkeys
    // per field element (since BN254's scalar field is ~254 bits and a
    // pubkey is 256 bits). Splitting + Poseidon-hashing eliminates that
    // class: (hi, lo) → pubkey is injective and Poseidon is collision
    // resistant in the field.
    let recipient_key = ctx.accounts.recipient.key();
    let recipient_bytes = pubkey_to_field_hash(&recipient_key)?;
    require!(recipient_bytes == recipient_field, MixerError::RecipientMismatch);

    let relayer_key = ctx.accounts.relayer.key();
    let relayer_bytes = pubkey_to_field_hash(&relayer_key)?;
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

/// Bind a 32-byte pubkey to a single BN254 field element via
/// `Poseidon(hi, lo)`, where (hi, lo) are the two 16-byte big-endian
/// halves of `pubkey.to_bytes()`, each zero-extended to 32 bytes.
///
/// 16-byte halves are ≤ 128 bits, well below the BN254 scalar field
/// order (~254 bits), so each half is a valid field input. The
/// (hi, lo) → pubkey mapping is injective, and Poseidon is collision
/// resistant in the field, so distinct pubkeys map to distinct field
/// elements — closing the mod-r collision class the previous version
/// allowed.
///
/// Off-chain (browser, relayer, integration tests) use the same
/// `Poseidon(hi, lo)` over circomlibjs, so the values match byte-for-byte.
/// Reject a 32-byte big-endian value that is not a canonical BN254
/// scalar field element (i.e. >= r). Big-endian byte-wise compare against
/// `BN254_FIELD_ORDER`.
fn require_lt_field_order(x: &[u8; 32]) -> Result<()> {
    use core::cmp::Ordering;
    for (a, b) in x.iter().zip(BN254_FIELD_ORDER.iter()) {
        match a.cmp(b) {
            Ordering::Less => return Ok(()),
            Ordering::Greater => return err!(MixerError::PublicInputOutOfRange),
            Ordering::Equal => continue,
        }
    }
    // x == r — also out of range.
    err!(MixerError::PublicInputOutOfRange)
}

fn pubkey_to_field_hash(pubkey: &Pubkey) -> Result<[u8; 32]> {
    let bytes = pubkey.to_bytes();

    let mut hi = [0u8; 32];
    hi[16..].copy_from_slice(&bytes[0..16]);

    let mut lo = [0u8; 32];
    lo[16..].copy_from_slice(&bytes[16..32]);

    let hash = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&hi, &lo])
        .map_err(|_| error!(MixerError::PoseidonHashFailed))?;
    Ok(hash.to_bytes())
}
