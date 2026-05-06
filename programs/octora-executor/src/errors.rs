use anchor_lang::prelude::*;

#[error_code]
pub enum ExecutorError {
    #[msg("DLMM program account does not match the configured program ID")]
    DlmmProgramMismatch,

    #[msg("DAMM program account does not match the configured program ID")]
    DammProgramMismatch,

    #[msg("Position account passed in does not match PoolAuthority position ref")]
    PositionMismatch,

    #[msg("LB pair account passed in does not match PoolAuthority pool ref")]
    LbPairMismatch,

    #[msg("DAMM pool account passed in does not match PoolAuthority pool ref")]
    DammPoolMismatch,

    #[msg("Stealth signer does not match PoolAuthority.stealth_pubkey")]
    StealthMismatch,

    #[msg("Token account owner does not match PoolAuthority.exit_recipient")]
    ExitRecipientMismatch,

    #[msg("Failed to deserialize SPL token account")]
    InvalidTokenAccount,

    #[msg("Forwarded token_program is not SPL Token or Token-2022")]
    InvalidTokenProgram,

    #[msg("Forwarded system_program / rent sysvar mismatch")]
    InvalidSysAccount,

    #[msg("DLMM event_authority PDA mismatch — possible IDL drift")]
    DlmmEventAuthorityMismatch,

    #[msg("DAMM event_authority PDA mismatch — possible IDL drift")]
    DammEventAuthorityMismatch,

    #[msg("Argument out of range (bin id ordering or basis points)")]
    ArgOutOfRange,

    #[msg("Forwarded remaining_accounts list is too short for this instruction")]
    AccountsTooShort,

    #[msg("PoolAuthority pool ref type does not match instruction expected type")]
    InvalidPoolRefType,

    #[msg("DAMM lock_escrow account does not match the derived PDA")]
    DammLockEscrowMismatch,

    #[msg("DAMM pool account passed does not match the one stored in PoolAuthority")]
    DammPoolStoredMismatch,

    #[msg("DAMM vault account validation failed")]
    DammVaultMismatch,

    #[msg("DAMM lp_mint account does not match the one stored in PoolAuthority")]
    DammLpMintMismatch,

    #[msg("DAMM owner account does not match the PoolAuthority PDA")]
    DammSolOwnerMismatch,
}
