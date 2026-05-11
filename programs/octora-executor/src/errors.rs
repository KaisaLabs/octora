use anchor_lang::prelude::*;

#[error_code]
pub enum ExecutorError {
    #[msg("DLMM program account does not match the configured program ID")]
    DlmmProgramMismatch,

    #[msg("Position account passed in does not match PoolAuthority position ref")]
    PositionMismatch,

    #[msg("LB pair account passed in does not match PoolAuthority pool ref")]
    LbPairMismatch,

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

    #[msg("Argument out of range (bin id ordering or basis points)")]
    ArgOutOfRange,

    #[msg("Forwarded remaining_accounts list is too short for this instruction")]
    AccountsTooShort,

    #[msg("DLMM position account must sign initialization")]
    MissingPositionSigner,

    // Retained: the reserved `PoolRef::Damm` enum variant in state.rs
    // (kept for on-chain backward compat with existing devnet
    // PoolAuthority accounts) still triggers this error if encountered
    // in a DLMM instruction context. Removing the variant would
    // re-serialize older accounts incorrectly.
    #[msg("PoolAuthority pool ref type does not match instruction expected type")]
    InvalidPoolRefType,

    #[msg("Lock escrow account does not match PoolAuthority lock_escrow")]
    LockEscrowMismatch,

    #[msg("SPL token account mint does not match the expected mint")]
    TokenMintMismatch,

    #[msg("Executor is paused — all state-mutating instructions are disabled")]
    Paused,

    #[msg("Caller is not authorized for this admin instruction")]
    Unauthorized,

    #[msg("Realised swap output below min_amount_out — slippage exceeded")]
    SwapSlippageExceeded,

    #[msg("Swap source pool must differ from LP target pool")]
    SwapSourceEqualsTarget,
}
