use anchor_lang::prelude::*;

#[error_code]
pub enum MixerError {
    #[msg("The mixer pool is currently paused")]
    PoolPaused,

    #[msg("Merkle tree is full (reached 2^20 leaves)")]
    TreeFull,

    #[msg("Provided Merkle siblings do not match the current root")]
    InvalidMerkleProof,

    #[msg("The provided root was not found in root history")]
    RootNotFound,

    #[msg("Groth16 proof verification failed")]
    InvalidProof,

    #[msg("Recipient account does not match the proof public input")]
    RecipientMismatch,

    #[msg("Relayer account does not match the proof public input")]
    RelayerMismatch,

    #[msg("Fee exceeds the pool denomination")]
    FeeExceedsDenomination,

    #[msg("Fee field exceeds u64 — upper 24 bytes must be zero")]
    FeeOverflow,

    #[msg("Insufficient pool balance for withdrawal")]
    InsufficientPoolBalance,

    #[msg("Unauthorized: only the authority can perform this action")]
    Unauthorized,
}
