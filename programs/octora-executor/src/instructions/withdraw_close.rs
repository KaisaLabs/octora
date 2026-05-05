use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::*;
use crate::dlmm::{build_dlmm_ix, invoke_dlmm_signed, require_token_account_owner};
use crate::errors::ExecutorError;
use crate::state::PositionAuthority;

/// Remove `bps_to_remove` of position liquidity in the inclusive bin range
/// `[from_bin_id, to_bin_id]`, then close the position. One executor ix
/// fans out to two DLMM CPIs so a stealth wallet exits with a single user
/// signature.
///
/// `remaining_accounts` packs the union of what `remove_liquidity_by_range`
/// and `close_position` need. The handler slices it into two views, one
/// per CPI:
///
///   0.  position                 (writable)               — both CPIs
///   1.  lb_pair                  (writable)               — both CPIs
///   2.  bin_array_bitmap_ext     (writable, optional)     — remove only
///                                  pass DLMM_PROGRAM_ID here when unused;
///                                  DLMM treats program-owned == None.
///   3.  user_token_x             (writable)               — remove only; owner == exit_recipient
///   4.  user_token_y             (writable)               — remove only; owner == exit_recipient
///   5.  reserve_x                (writable)               — remove only
///   6.  reserve_y                (writable)               — remove only
///   7.  token_x_mint                                       — remove only
///   8.  token_y_mint                                       — remove only
///   9.  bin_array_lower          (writable)               — both CPIs
///   10. bin_array_upper          (writable)               — both CPIs
///   11. sender                   (signer)                 — pinned to PDA, both CPIs
///   12. token_x_program                                    — remove only
///   13. token_y_program                                    — remove only
///   14. event_authority          (DLMM PDA)               — both CPIs
///   15. program                  (DLMM)                   — both CPIs
///   16. rent_receiver            (writable)               — close only; must == exit_recipient
#[derive(Accounts)]
pub struct WithdrawClose<'info> {
    pub stealth: Signer<'info>,

    #[account(
        mut, // close_position credits SOL rebate to rent_receiver via DLMM, but
             // PositionAuthority itself stays alive across this ix; mut here is
             // belt-and-braces so any future bookkeeping write doesn't ABI-break.
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
    ctx: Context<'_, '_, '_, 'info, WithdrawClose<'info>>,
    from_bin_id: i32,
    to_bin_id: i32,
    bps_to_remove: u16,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.dlmm_program.key(),
        DLMM_PROGRAM_ID,
        ExecutorError::DlmmProgramMismatch,
    );

    let pa = &ctx.accounts.position_authority;
    let remaining = ctx.remaining_accounts;

    // Slot 16 is the close-only rent receiver; demand the full union up
    // front so we don't fail mid-CPI with a less helpful error.
    require!(remaining.len() >= 17, ExecutorError::PositionMismatch);

    // ── Cross-checks against PA state ──────────────────────────────────

    let position_ai = &remaining[0];
    require_keys_eq!(position_ai.key(), pa.position, ExecutorError::PositionMismatch);

    let lb_pair_ai = &remaining[1];
    require_keys_eq!(lb_pair_ai.key(), pa.lb_pair, ExecutorError::LbPairMismatch);

    require_token_account_owner(&remaining[3], &pa.exit_recipient)?;
    require_token_account_owner(&remaining[4], &pa.exit_recipient)?;

    // rent_receiver must equal exit_recipient. close_position credits the
    // position account's rent rebate to this address, so it's effectively
    // a SOL-out path that needs the same policy as the token outflows.
    require_keys_eq!(
        remaining[16].key(),
        pa.exit_recipient,
        ExecutorError::ExitRecipientMismatch,
    );

    let pa_key = pa.key();
    let stealth_key = ctx.accounts.stealth.key();
    let bump = pa.bump;
    let signer_seeds: &[&[u8]] = &[
        POSITION_AUTHORITY_SEED,
        stealth_key.as_ref(),
        &[bump],
    ];

    // Helper to build a meta list with idx `signer_idx` re-pinned to the PDA.
    let build_metas = |indices: &[usize], signer_idx: usize| -> Vec<AccountMeta> {
        indices
            .iter()
            .map(|&i| {
                let ai = &remaining[i];
                if i == signer_idx {
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
            .collect()
    };

    // ── CPI 1: remove_liquidity_by_range ──────────────────────────────
    //
    // remove takes idx 0..=15 in their natural order. sender is at idx 11.
    let remove_indices: Vec<usize> = (0..=15).collect();
    let remove_metas = build_metas(&remove_indices, 11);

    let mut remove_args = Vec::with_capacity(10);
    remove_args.extend_from_slice(&from_bin_id.to_le_bytes());
    remove_args.extend_from_slice(&to_bin_id.to_le_bytes());
    remove_args.extend_from_slice(&bps_to_remove.to_le_bytes());

    let remove_ix = build_dlmm_ix(
        DLMM_PROGRAM_ID,
        "remove_liquidity_by_range",
        remove_metas,
        remove_args,
    );
    invoke_dlmm_signed(&remove_ix, remaining, &[signer_seeds])?;

    // ── CPI 2: close_position ──────────────────────────────────────────
    //
    // close takes 8 accounts in this order:
    //   position, lb_pair, bin_array_lower, bin_array_upper, sender,
    //   rent_receiver, event_authority, program
    // → indices [0, 1, 9, 10, 11, 16, 14, 15]; sender (now at position 4
    // of this sub-list, source idx 11) is the signer slot.
    let close_indices = [0usize, 1, 9, 10, 11, 16, 14, 15];
    let close_metas = build_metas(&close_indices, 11);

    let close_ix = build_dlmm_ix(DLMM_PROGRAM_ID, "close_position", close_metas, Vec::new());
    invoke_dlmm_signed(&close_ix, remaining, &[signer_seeds])?;

    msg!(
        "withdraw_close: stealth={} pa={} position={} bps={}",
        stealth_key,
        pa_key,
        pa.position,
        bps_to_remove,
    );

    Ok(())
}
