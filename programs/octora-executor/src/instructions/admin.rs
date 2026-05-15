use anchor_lang::prelude::*;

use crate::constants::CONFIG_SEED;
#[cfg(not(feature = "permissionless-init"))]
use crate::constants::EXECUTOR_ADMIN_AUTHORITY;
use crate::errors::ExecutorError;
use crate::state::Config;

/// One-shot initializer for the global executor `Config` PDA.
///
/// `init_config` is gated on `EXECUTOR_ADMIN_AUTHORITY` (see `constants.rs`).
/// The first caller becomes `Config.authority` forever and is the only key
/// that can flip `paused` — leaving this permissionless would let any
/// front-runner claim authority over the executor.
///
/// For devnet/local-only testing, build with `--features permissionless-init`
/// to drop the address constraint. The default (mainnet) feature set keeps
/// the gate active; `EXECUTOR_ADMIN_AUTHORITY` is a placeholder so init
/// fails closed until the real multisig pubkey is wired in.
#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[cfg_attr(
        not(feature = "permissionless-init"),
        account(mut, address = EXECUTOR_ADMIN_AUTHORITY @ ExecutorError::Unauthorized),
    )]
    #[cfg_attr(feature = "permissionless-init", account(mut))]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Config::SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

pub fn init_config_handler(ctx: Context<InitConfig>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.paused = false;
    config.bump = ctx.bumps.config;

    msg!(
        "executor config initialized — authority={} paused={}",
        config.authority,
        config.paused
    );
    Ok(())
}

/// Authority-gated emergency pause toggle.
///
/// `Config.paused` blocks every state-mutating DLMM instruction.
/// The authority is set at `init_config` and is the only key allowed to
/// flip this flag.
#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ ExecutorError::Unauthorized,
    )]
    pub config: Account<'info, Config>,
}

pub fn set_paused_handler(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.paused = paused;

    msg!(
        "executor pause = {} (authority={})",
        paused,
        ctx.accounts.authority.key()
    );
    Ok(())
}
