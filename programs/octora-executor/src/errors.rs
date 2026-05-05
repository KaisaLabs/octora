use anchor_lang::prelude::*;

#[error_code]
pub enum ExecutorError {
    #[msg("DLMM program account does not match the configured program ID")]
    DlmmProgramMismatch,

    #[msg("Position account passed in does not match PositionAuthority.position")]
    PositionMismatch,

    #[msg("LB pair account passed in does not match PositionAuthority.lb_pair")]
    LbPairMismatch,

    #[msg("Stealth signer does not match PositionAuthority.stealth_pubkey")]
    StealthMismatch,

    #[msg("Token account owner does not match PositionAuthority.exit_recipient")]
    ExitRecipientMismatch,

    #[msg("Failed to deserialize SPL token account")]
    InvalidTokenAccount,
}
