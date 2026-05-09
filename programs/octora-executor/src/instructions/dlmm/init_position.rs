use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::POOL_AUTHORITY_SEED;
use crate::cpi::dlmm::*;
use crate::cpi::{require_rent_sysvar, require_system_program};
use crate::errors::ExecutorError;
use crate::state::{PoolAuthority, PoolRef};

#[derive(Accounts)]
pub struct DlmmInitPosition<'info> {
    #[account(mut)]
    pub stealth: Signer<'info>,

    #[account(
        init,
        payer = stealth,
        space = PoolAuthority::SPACE,
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), lb_pair.key().as_ref()],
        bump,
    )]
    pub pool_authority: Account<'info, PoolAuthority>,

    /// CHECK: validated in handler against the forwarded lb_pair in remaining_accounts[2].
    pub lb_pair: UncheckedAccount<'info>,

    /// CHECK: validated in handler against canonical DLMM program ID.
    pub dlmm_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DlmmInitPosition<'info>>,
    lower_bin_id: i32,
    width: i32,
    exit_recipient: Pubkey,
) -> Result<()> {
    // ── DLMM program ID validation ──
    require_dlmm_program(&ctx.accounts.dlmm_program)?;

    let remaining = ctx.remaining_accounts;
    require!(remaining.len() == 8, ExecutorError::AccountsTooShort);

    let position_account = &remaining[1];
    let lb_pair_account = &remaining[2];

    require!(
        position_account.is_signer,
        ExecutorError::MissingPositionSigner,
    );
    require_keys_eq!(
        ctx.accounts.lb_pair.key(),
        lb_pair_account.key(),
        ExecutorError::LbPairMismatch,
    );

    // ── System / rent / event authority / DLMM program validation ──
    require_system_program(&remaining[4])?;
    require_rent_sysvar(&remaining[5])?;
    require_dlmm_event_authority(&remaining[6])?;
    require_dlmm_program(&remaining[7])?;

    let stealth_key = ctx.accounts.stealth.key();
    let pa_bump = ctx.bumps.pool_authority;
    let lb_pair_key = lb_pair_account.key();

    let pa = &mut ctx.accounts.pool_authority;
    pa.stealth_pubkey = stealth_key;
    pa.exit_recipient = exit_recipient;
    pa.pool_ref = PoolRef::Dlmm {
        lb_pair: lb_pair_key,
        position: position_account.key(),
    };
    pa.bump = pa_bump;

    // ── Build DLMM initialize_position CPI ──
    let mut args = Vec::with_capacity(8);
    args.extend_from_slice(&lower_bin_id.to_le_bytes());
    args.extend_from_slice(&width.to_le_bytes());

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

    let ix = build_dlmm_ix("initialize_position", metas, args);

    let signer_seeds: &[&[u8]] = &[
        POOL_AUTHORITY_SEED,
        stealth_key.as_ref(),
        lb_pair_key.as_ref(),
        &[pa_bump],
    ];

    // CPI signer re-pinning: include PDA AccountInfo
    let pa_info = ctx.accounts.pool_authority.to_account_info();
    let mut infos: Vec<AccountInfo> = remaining.to_vec();
    infos[3] = pa_info;
    invoke_dlmm_signed(&ix, &infos, &[signer_seeds])?;

    msg!(
        "dlmm_init_position: stealth={} pa={} lb_pair={} position={}",
        stealth_key,
        pa_key,
        lb_pair_key,
        position_account.key(),
    );

    Ok(())
}
