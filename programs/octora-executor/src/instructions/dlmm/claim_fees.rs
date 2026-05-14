use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::{CONFIG_SEED, POOL_AUTHORITY_SEED};
use crate::cpi::dlmm::*;
use crate::cpi::{
    require_spl_token_program, require_token_account_mint, require_token_account_owner,
};
use crate::errors::ExecutorError;
use crate::state::{Config, PoolAuthority, PoolRef};

#[derive(Accounts)]
pub struct DlmmClaimFees<'info> {
    pub stealth: Signer<'info>,

    #[account(
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), lb_pair.key().as_ref()],
        bump = pool_authority.bump,
        constraint = pool_authority.stealth_pubkey == stealth.key()
            @ ExecutorError::StealthMismatch,
    )]
    pub pool_authority: Account<'info, PoolAuthority>,

    /// CHECK: validated in handler against stored PoolAuthority lb_pair.
    pub lb_pair: UncheckedAccount<'info>,

    /// CHECK: validated in handler against canonical DLMM program ID.
    pub dlmm_program: UncheckedAccount<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ ExecutorError::Paused,
    )]
    pub config: Account<'info, Config>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DlmmClaimFees<'info>>,
    min_bin_id: i32,
    max_bin_id: i32,
    remaining_accounts_info: Vec<u8>,
) -> Result<()> {
    require_dlmm_program(&ctx.accounts.dlmm_program)?;

    let pa = &ctx.accounts.pool_authority;
    let remaining = ctx.remaining_accounts;

    // v2 layout (claim_fee2):
    //   0 lb_pair, 1 position, 2 sender (PA — re-pinned below),
    //   3 reserve_x, 4 reserve_y, 5 user_token_x, 6 user_token_y,
    //   7 token_x_mint, 8 token_y_mint, 9 token_program_x,
    //   10 token_program_y, 11 memo_program, 12 event_authority, 13 program.
    //   tail: transfer-hook accounts + bin arrays (variable per
    //         remaining_accounts_info).
    require!(remaining.len() >= 14, ExecutorError::AccountsTooShort);

    let (stored_lb_pair, stored_position) = match &pa.pool_ref {
        PoolRef::Dlmm { lb_pair, position } => (*lb_pair, *position),
        _ => return Err(error!(ExecutorError::InvalidPoolRefType)),
    };

    require_keys_eq!(
        remaining[0].key(),
        stored_lb_pair,
        ExecutorError::LbPairMismatch
    );
    require_keys_eq!(
        remaining[1].key(),
        stored_position,
        ExecutorError::PositionMismatch
    );
    require_token_account_owner(&remaining[5], &pa.exit_recipient)?;
    require_token_account_owner(&remaining[6], &pa.exit_recipient)?;
    require_token_account_mint(&remaining[5], &remaining[9], &remaining[7].key())?;
    require_token_account_mint(&remaining[6], &remaining[10], &remaining[8].key())?;
    require_spl_token_program(&remaining[9])?;
    require_spl_token_program(&remaining[10])?;
    require_dlmm_event_authority(&remaining[12])?;
    require_dlmm_program(&remaining[13])?;
    require_keys_eq!(
        ctx.accounts.lb_pair.key(),
        stored_lb_pair,
        ExecutorError::LbPairMismatch
    );

    let pa_key = pa.key();
    let metas: Vec<AccountMeta> = remaining
        .iter()
        .enumerate()
        .map(|(i, ai)| {
            // v2 sender at slot 2 (was 4 in v1).
            if i == 2 {
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

    // v2 payload = min_bin_id (i32 LE) + max_bin_id (i32 LE) + remaining_accounts_info bytes.
    let mut payload = Vec::with_capacity(8 + remaining_accounts_info.len());
    payload.extend_from_slice(&min_bin_id.to_le_bytes());
    payload.extend_from_slice(&max_bin_id.to_le_bytes());
    payload.extend_from_slice(&remaining_accounts_info);

    let ix = build_dlmm_ix("claim_fee2", metas, payload);

    let stealth_key = ctx.accounts.stealth.key();
    let bump = pa.bump;
    let signer_seeds: &[&[u8]] = &[
        POOL_AUTHORITY_SEED,
        stealth_key.as_ref(),
        stored_lb_pair.as_ref(),
        &[bump],
    ];

    // Fix #4: CPI signer re-pinning at v2 sender slot 2.
    let pa_info = ctx.accounts.pool_authority.to_account_info();
    let mut infos: Vec<AccountInfo> = remaining.to_vec();
    infos[2] = pa_info;
    invoke_dlmm_signed(&ix, &infos, &[signer_seeds])?;

    msg!(
        "dlmm_claim_fees: stealth={} pa={} position={} range=[{},{}]",
        stealth_key,
        pa_key,
        stored_position,
        min_bin_id,
        max_bin_id,
    );

    Ok(())
}
