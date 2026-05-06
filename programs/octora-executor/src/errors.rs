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

    #[msg("Forwarded token_program is not SPL Token or Token-2022")]
    InvalidTokenProgram,

    #[msg("Forwarded system_program / rent sysvar mismatch")]
    InvalidSysAccount,

    #[msg("DLMM event_authority PDA mismatch — possible IDL drift")]
    EventAuthorityMismatch,

    #[msg("Argument out of range (bin id ordering or basis points)")]
    ArgOutOfRange,

    #[msg("Forwarded remaining_accounts list is too short for this instruction")]
    AccountsTooShort,
}
