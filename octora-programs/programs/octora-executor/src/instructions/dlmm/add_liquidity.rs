use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::{CONFIG_SEED, POOL_AUTHORITY_SEED};
use crate::cpi::dlmm::*;
use crate::cpi::{require_spl_token_program, require_token_account_mint};
use crate::errors::ExecutorError;
use crate::state::{Config, PoolAuthority, PoolRef};

#[derive(Accounts)]
pub struct DlmmAddLiquidity<'info> {
    pub stealth: Signer<'info>,

    #[account(
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), lb_pair.key().as_ref()],
        bump = pool_authority.bump,
        constraint = pool_authority.stealth_pubkey == stealth.key()
            @ ExecutorError::StealthMismatch,
    )]
    pub pool_authority: Account<'info, PoolAuthority>,

    /// CHECK: validated in handler against canonical DLMM program ID.
    pub dlmm_program: UncheckedAccount<'info>,

    /// CHECK: validated in handler against stored PoolAuthority lb_pair.
    pub lb_pair: UncheckedAccount<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ ExecutorError::Paused,
    )]
    pub config: Account<'info, Config>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DlmmAddLiquidity<'info>>,
    liquidity_params: Vec<u8>,
) -> Result<()> {
    require_dlmm_program(&ctx.accounts.dlmm_program)?;

    let pa = &ctx.accounts.pool_authority;
    let remaining = ctx.remaining_accounts;

    // v2 layout (add_liquidity_by_strategy2):
    //   fixed:    0 position, 1 lb_pair, 2 bin_array_bitmap_extension (sentinel
    //             = DLMM program when None), 3 user_token_x, 4 user_token_y,
    //             5 reserve_x, 6 reserve_y, 7 token_x_mint, 8 token_y_mint,
    //             9 sender (PA — re-pinned below), 10 token_x_program,
    //             11 token_y_program, 12 event_authority, 13 program.
    //   tail:    transfer-hook accounts (variable, described by the
    //            RemainingAccountsInfo embedded in `liquidity_params`),
    //            followed by bin_array_lower, bin_array_upper.
    //
    // The caller passes the full v2 payload bytes (LiquidityParameterByStrategy
    // borsh + RemainingAccountsInfo borsh) as `liquidity_params`; the executor
    // is opaque to its contents.
    //
    // Minimum total = 14 fixed + 2 bin arrays = 16. With hooks the count
    // grows but the bin arrays still sit at the tail.
    require!(remaining.len() >= 16, ExecutorError::AccountsTooShort);

    let PoolRef::Dlmm {
        lb_pair: stored_lb_pair,
        position,
    } = &pa.pool_ref;
    require_keys_eq!(
        remaining[0].key(),
        *position,
        ExecutorError::PositionMismatch
    );
    require_keys_eq!(
        remaining[1].key(),
        *stored_lb_pair,
        ExecutorError::LbPairMismatch
    );

    require_keys_eq!(
        remaining[1].key(),
        ctx.accounts.lb_pair.key(),
        ExecutorError::LbPairMismatch
    );

    require_token_account_mint(&remaining[3], &remaining[10], &remaining[7].key())?;
    require_token_account_mint(&remaining[4], &remaining[11], &remaining[8].key())?;
    require_spl_token_program(&remaining[10])?;
    require_spl_token_program(&remaining[11])?;
    require_dlmm_event_authority(&remaining[12])?;
    require_dlmm_program(&remaining[13])?;

    let pa_key = pa.key();
    let metas: Vec<AccountMeta> = remaining
        .iter()
        .enumerate()
        .map(|(i, ai)| {
            // v2 sender at slot 9 (was 11 in v1).
            if i == 9 {
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

    let ix = build_dlmm_ix("add_liquidity_by_strategy2", metas, liquidity_params);

    let stealth_key = ctx.accounts.stealth.key();
    let bump = pa.bump;
    let PoolRef::Dlmm { lb_pair: lb_pair_key, .. } = &pa.pool_ref;
    let lb_pair_key = *lb_pair_key;
    let signer_seeds: &[&[u8]] = &[
        POOL_AUTHORITY_SEED,
        stealth_key.as_ref(),
        lb_pair_key.as_ref(),
        &[bump],
    ];

    // Fix #4: CPI signer re-pinning at v2 sender slot 9.
    let pa_info = ctx.accounts.pool_authority.to_account_info();
    let mut infos: Vec<AccountInfo> = remaining.to_vec();
    infos[9] = pa_info;
    invoke_dlmm_signed(&ix, &infos, &[signer_seeds])?;

    msg!(
        "dlmm_add_liquidity: stealth={} pa={} position={}",
        stealth_key,
        pa_key,
        remaining[0].key(),
    );

    Ok(())
}
