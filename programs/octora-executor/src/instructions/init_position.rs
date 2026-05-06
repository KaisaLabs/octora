use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::*;
use crate::dlmm::{
    build_dlmm_ix, invoke_dlmm_signed, require_dlmm_event_authority, require_dlmm_program,
    require_rent_sysvar, require_system_program,
};
use crate::errors::ExecutorError;
use crate::state::PositionAuthority;

/// Initialise a Meteora DLMM position whose owner is a PDA controlled by
/// this program on behalf of `stealth`.
///
/// Account ordering for `remaining_accounts` must match exactly what DLMM's
/// `initialize_position` ix expects (verified against the IDL embedded in
/// `@meteora-ag/dlmm`):
///
///   0. payer            (writable, signer)  — fee payer (typically the relayer)
///   1. position         (writable, signer)  — fresh keypair for the position
///   2. lb_pair          (readable)          — the LB pair this position joins
///   3. owner            (signer)            — position owner = our PDA
///   4. system_program
///   5. rent
///   6. event_authority  (readable, PDA of DLMM, seeds = [b"__event_authority"])
///   7. program          (readable)          — the DLMM program itself
///
/// We re-pin `owner` (idx 3) to our PDA inside the handler so a caller
/// cannot lie about it. Everything else is forwarded as-is.
#[derive(Accounts)]
pub struct InitPosition<'info> {
    /// The stealth wallet that authorises this position. It is the outer
    /// signer; it does NOT sign the inner DLMM CPI — the PDA does.
    #[account(mut)]
    pub stealth: Signer<'info>,

    /// PDA created here. Owns the Meteora position from DLMM's perspective.
    #[account(
        init,
        payer = stealth,
        space = PositionAuthority::SPACE,
        seeds = [POSITION_AUTHORITY_SEED, stealth.key().as_ref()],
        bump,
    )]
    pub position_authority: Account<'info, PositionAuthority>,

    /// The Meteora DLMM program. Verified against `DLMM_PROGRAM_ID`.
    /// CHECK: program ID equality is checked in the handler.
    pub dlmm_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, InitPosition<'info>>,
    lower_bin_id: i32,
    width: i32,
    exit_recipient: Pubkey,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.dlmm_program.key(),
        DLMM_PROGRAM_ID,
        ExecutorError::DlmmProgramMismatch,
    );

    // Forwarded DLMM accounts (see ix-level docs above for ordering).
    let remaining = ctx.remaining_accounts;
    require!(remaining.len() >= 8, ExecutorError::AccountsTooShort);

    let position_account = &remaining[1];
    let lb_pair_account = &remaining[2];

    // Defense-in-depth: pin the well-known program/sysvar slots so a caller
    // cannot substitute fakes that DLMM might forward into its own CPIs.
    require_system_program(&remaining[4])?;
    require_rent_sysvar(&remaining[5])?;
    require_dlmm_event_authority(&remaining[6])?;
    require_dlmm_program(&remaining[7])?;

    // Cache PDA bookkeeping before we hand the AccountInfos to invoke_signed.
    let stealth_key = ctx.accounts.stealth.key();
    let pa_bump = ctx.bumps.position_authority;

    // Persist authority bookkeeping. We commit before the CPI so that if DLMM
    // fails the whole tx unwinds atomically — we don't need to roll back.
    let pa = &mut ctx.accounts.position_authority;
    pa.stealth_pubkey = stealth_key;
    pa.lb_pair = lb_pair_account.key();
    pa.position = position_account.key();
    pa.exit_recipient = exit_recipient;
    pa.bump = pa_bump;

    // Build the inner ix.
    //
    // Args layout for DLMM `initialize_position` is `(lower_bin_id: i32, width: i32)`,
    // Borsh-encoded. If Meteora ever renames or extends, only this block changes.
    let mut args = Vec::with_capacity(8);
    args.extend_from_slice(&lower_bin_id.to_le_bytes());
    args.extend_from_slice(&width.to_le_bytes());

    // Re-pin owner (idx 3) to our PDA's pubkey, marking it as signer.
    let pa_key = pa.key();
    let metas: Vec<AccountMeta> = remaining
        .iter()
        .enumerate()
        .map(|(i, ai)| {
            if i == 3 {
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

    let ix = build_dlmm_ix(DLMM_PROGRAM_ID, "initialize_position", metas, args);

    // AccountInfos passed to invoke_signed must include every account the ix
    // references, plus the program account. We pass the remaining_accounts
    // verbatim — the program account is already at idx 7 by the spec above.
    let signer_seeds: &[&[u8]] = &[
        POSITION_AUTHORITY_SEED,
        stealth_key.as_ref(),
        &[pa_bump],
    ];

    invoke_dlmm_signed(&ix, remaining, &[signer_seeds])?;

    msg!(
        "init_position: stealth={} pa={} lb_pair={} position={}",
        stealth_key,
        pa_key,
        pa.lb_pair,
        pa.position,
    );

    Ok(())
}
