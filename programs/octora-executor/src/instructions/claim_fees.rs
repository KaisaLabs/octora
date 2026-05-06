use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::*;
use crate::dlmm::{
    build_dlmm_ix, invoke_dlmm_signed, require_dlmm_event_authority, require_dlmm_program,
    require_spl_token_program, require_token_account_owner,
};
use crate::errors::ExecutorError;
use crate::state::PositionAuthority;

/// Claim swap fees on a DLMM position into ATAs whose owner is pinned to
/// `PositionAuthority.exit_recipient`.
///
/// `remaining_accounts` ordering matches DLMM's `claim_fee` (lb_clmm IDL
/// version 1.9.x):
///
///   0.  lb_pair          (writable)
///   1.  position         (writable)
///   2.  bin_array_lower  (writable)
///   3.  bin_array_upper  (writable)
///   4.  sender           (signer)               — pinned to our PDA
///   5.  reserve_x        (writable)
///   6.  reserve_y        (writable)
///   7.  user_token_x     (writable)             — owner must equal exit_recipient
///   8.  user_token_y     (writable)             — owner must equal exit_recipient
///   9.  token_x_mint
///   10. token_y_mint
///   11. token_program
///   12. event_authority  (DLMM PDA)
///   13. program          (DLMM)
///
/// No args.
#[derive(Accounts)]
pub struct ClaimFees<'info> {
    /// Stealth wallet authorising the claim. Outer signer only.
    pub stealth: Signer<'info>,

    /// PDA that owns the Meteora position. Position + lb_pair + exit_recipient
    /// are read from here and enforced against the forwarded accounts.
    #[account(
        seeds = [POSITION_AUTHORITY_SEED, stealth.key().as_ref()],
        bump = position_authority.bump,
        constraint = position_authority.stealth_pubkey == stealth.key()
            @ ExecutorError::StealthMismatch,
    )]
    pub position_authority: Account<'info, PositionAuthority>,

    /// CHECK: program ID equality is checked in the handler.
    pub dlmm_program: UncheckedAccount<'info>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, ClaimFees<'info>>,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.dlmm_program.key(),
        DLMM_PROGRAM_ID,
        ExecutorError::DlmmProgramMismatch,
    );

    let pa = &ctx.accounts.position_authority;
    let remaining = ctx.remaining_accounts;
    require!(remaining.len() >= 14, ExecutorError::AccountsTooShort);

    // Cross-check the forwarded accounts that PositionAuthority pins.
    require_keys_eq!(remaining[0].key(), pa.lb_pair, ExecutorError::LbPairMismatch);
    require_keys_eq!(remaining[1].key(), pa.position, ExecutorError::PositionMismatch);

    // Pin destination ATAs to exit_recipient. Even with the stealth key,
    // an attacker can't substitute their own ATA here.
    require_token_account_owner(&remaining[7], &pa.exit_recipient)?;
    require_token_account_owner(&remaining[8], &pa.exit_recipient)?;

    // Pin token program + IDL-drift canary at the trailing slots.
    require_spl_token_program(&remaining[11])?;
    require_dlmm_event_authority(&remaining[12])?;
    require_dlmm_program(&remaining[13])?;

    // Pin sender (idx 4) to our PDA. The pubkey override is what makes the
    // `invoke_signed` call act as the PDA, not the caller's choice.
    let pa_key = pa.key();
    let metas: Vec<AccountMeta> = remaining
        .iter()
        .enumerate()
        .map(|(i, ai)| {
            if i == 4 {
                AccountMeta {
                    pubkey: pa_key,
                    is_signer: true,
                    is_writable: ai.is_writable,
                }
            } else {
                AccountMeta {
                    pubkey: ai.key(),
                    is_signer: ai.is_signer,
                    is_writable: ai.is_writable,
                }
            }
        })
        .collect();

    let ix = build_dlmm_ix(DLMM_PROGRAM_ID, "claim_fee", metas, Vec::new());

    let stealth_key = ctx.accounts.stealth.key();
    let bump = pa.bump;
    let signer_seeds: &[&[u8]] = &[
        POSITION_AUTHORITY_SEED,
        stealth_key.as_ref(),
        &[bump],
    ];

    invoke_dlmm_signed(&ix, remaining, &[signer_seeds])?;

    msg!(
        "claim_fees: stealth={} pa={} position={}",
        stealth_key,
        pa_key,
        pa.position,
    );

    Ok(())
}
