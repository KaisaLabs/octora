use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::*;
use crate::dlmm::{
    build_dlmm_ix, invoke_dlmm_signed, require_dlmm_event_authority, require_dlmm_program,
    require_spl_token_program,
};
use crate::errors::ExecutorError;
use crate::state::PositionAuthority;

/// Add liquidity to an existing DLMM position via `add_liquidity_by_strategy`.
///
/// `remaining_accounts` ordering must match DLMM's `add_liquidity_by_strategy`
/// ix. From lb_clmm 0.x:
///
///   0. position           (writable)            — must equal pa.position
///   1. lb_pair            (writable)            — must equal pa.lb_pair
///   2. bin_array_bitmap_ext (writable, optional)
///   3. user_token_x       (writable)
///   4. user_token_y       (writable)
///   5. reserve_x          (writable)
///   6. reserve_y          (writable)
///   7. token_x_mint       (readable)
///   8. token_y_mint       (readable)
///   9. bin_array_lower    (writable)
///  10. bin_array_upper    (writable)
///  11. sender             (signer)              — pinned to our PDA
///  12. token_x_program    (readable)
///  13. token_y_program    (readable)
///  14. event_authority    (readable, DLMM PDA)
///  15. program            (readable)            — the DLMM program itself
///
/// Anything DLMM expects beyond this list (e.g. extra bin arrays via their
/// own `remaining_accounts`) can be appended after idx 15 and we forward
/// them transparently.
#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    /// Stealth wallet authorising the deposit. Outer signer only.
    pub stealth: Signer<'info>,

    /// PDA that owns the Meteora position. Must already exist (created via
    /// `init_position`).
    ///
    /// `seeds` re-derives the address from the stealth signer, so the only
    /// way to land on this PDA is to sign with the wallet it was created
    /// for. The explicit `constraint` is belt-and-braces: even if a future
    /// change adds an index byte to the seeds, the on-account
    /// `stealth_pubkey` field still has to match.
    #[account(
        seeds = [POSITION_AUTHORITY_SEED, stealth.key().as_ref()],
        bump = position_authority.bump,
        constraint = position_authority.stealth_pubkey == stealth.key()
            @ ExecutorError::StealthMismatch,
    )]
    pub position_authority: Account<'info, PositionAuthority>,

    /// The DLMM program — verified by program ID.
    /// CHECK: program ID equality is checked in the handler.
    pub dlmm_program: UncheckedAccount<'info>,
}

/// Mirrors DLMM's `LiquidityParameterByStrategy`. We forward bytes through
/// without interpreting the strategy — Meteora owns the schema. The caller
/// (TS client) must serialise it identically.
///
/// Concretely DLMM expects (Borsh-encoded):
///   { amount_x: u64, amount_y: u64, active_id: i32, max_active_bin_slippage: i32,
///     strategy_parameters: StrategyParameters }
///
/// We accept the entire blob pre-encoded to keep this program decoupled from
/// DLMM's strategy enum. If you want a typed wrapper later, replace this
/// with `#[derive(AnchorSerialize, AnchorDeserialize)]` mirrors and call
/// `params.try_to_vec()` instead.
pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, AddLiquidity<'info>>,
    liquidity_params: Vec<u8>,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.dlmm_program.key(),
        DLMM_PROGRAM_ID,
        ExecutorError::DlmmProgramMismatch,
    );

    let pa = &ctx.accounts.position_authority;
    let remaining = ctx.remaining_accounts;
    require!(remaining.len() >= 16, ExecutorError::AccountsTooShort);

    // Sanity check: forwarded position + lb_pair must match what we registered
    // in init_position. Without this, a caller could swap in someone else's
    // position and have our PDA sign for it.
    require_keys_eq!(remaining[0].key(), pa.position, ExecutorError::PositionMismatch);
    require_keys_eq!(remaining[1].key(), pa.lb_pair, ExecutorError::LbPairMismatch);

    // Pin token programs (idx 12, 13) so DLMM's internal CPIs can't be
    // hijacked by a caller-supplied fake token program signing as our PDA.
    require_spl_token_program(&remaining[12])?;
    require_spl_token_program(&remaining[13])?;

    // IDL-drift canary + program identity at the trailing slots.
    require_dlmm_event_authority(&remaining[14])?;
    require_dlmm_program(&remaining[15])?;

    // Pin sender (idx 11) to our PDA, marked as signer.
    let pa_key = pa.key();
    let metas: Vec<AccountMeta> = remaining
        .iter()
        .enumerate()
        .map(|(i, ai)| {
            if i == 11 {
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

    let ix = build_dlmm_ix(
        DLMM_PROGRAM_ID,
        "add_liquidity_by_strategy",
        metas,
        liquidity_params,
    );

    let stealth_key = ctx.accounts.stealth.key();
    let bump = pa.bump;
    let signer_seeds: &[&[u8]] = &[
        POSITION_AUTHORITY_SEED,
        stealth_key.as_ref(),
        &[bump],
    ];

    invoke_dlmm_signed(&ix, remaining, &[signer_seeds])?;

    msg!(
        "add_liquidity: stealth={} pa={} position={}",
        stealth_key,
        pa_key,
        pa.position,
    );

    Ok(())
}
