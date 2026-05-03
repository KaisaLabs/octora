use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod verifier;

use instructions::*;

declare_id!("Ao58tvHj3FTwFMiGts5HAc5mastNE61Puiw4ER3rA3NJ");

#[program]
pub mod octora_mixer {
    use super::*;

    /// Initialize a new mixer pool with a fixed denomination.
    /// Only one pool per denomination is allowed (PDA constraint).
    pub fn initialize(ctx: Context<Initialize>, denomination: u64) -> Result<()> {
        instructions::initialize::handler(ctx, denomination)
    }

    /// Deposit SOL into the mixer pool.
    /// The depositor provides a commitment (Poseidon hash of secret + nullifier)
    /// and the current Merkle siblings for root verification and update.
    pub fn deposit(
        ctx: Context<Deposit>,
        commitment: [u8; 32],
        proof_siblings: [[u8; 32]; 20],
    ) -> Result<()> {
        instructions::deposit::handler(ctx, commitment, proof_siblings)
    }

    /// Withdraw SOL from the mixer pool using a Groth16 ZK proof.
    /// The relayer submits the proof on behalf of the user.
    /// Funds go to the recipient (stealth wallet), fees go to the relayer.
    pub fn withdraw(
        ctx: Context<Withdraw>,
        proof_data: [u8; 256],
        public_inputs: [u8; 160],
    ) -> Result<()> {
        instructions::withdraw::handler(ctx, proof_data, public_inputs)
    }
}
