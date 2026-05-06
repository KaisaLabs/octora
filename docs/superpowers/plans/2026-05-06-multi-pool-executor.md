# Multi-Pool-Type Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend octora-executor to support both Meteora DLMM and DAMM pool types with modular, maintainable architecture.

**Architecture:** PoolRef enum for type-safe pool state, per-pool PDA seeds, shared CPI primitives with pool-specific builders. Single-side LP (SOL only), Token-2022 support required, lock escrow closure on withdraw.

**Tech Stack:** Anchor 0.30.1, Rust, Solana 1.18.x, @mercurial-finance/dynamic-amm-sdk, @meteora-ag/dlmm

---

## File Structure

### New Files (Create)
```
programs/octora-executor/src/
├── state/
│   ├── mod.rs
│   └── pool_authority.rs
├── cpi/
│   ├── mod.rs
│   ├── dlmm.rs
│   └── damm.rs
└── instructions/
    ├── dlmm/
    │   ├── mod.rs
    │   ├── init_position.rs
    │   ├── add_liquidity.rs
    │   ├── claim_fees.rs
    │   └── withdraw_close.rs
    └── damm/
        ├── mod.rs
        ├── init.rs
        ├── deposit.rs
        ├── withdraw.rs
        └── claim_fees.rs
```

### Modified Files
```
programs/octora-executor/src/
├── lib.rs                    # Add DAMM entrypoints, import new modules
├── constants.rs              # Add DAMM/vault program IDs, new seeds
├── errors.rs                 # Add DAMM-specific errors
├── state.rs                  # Remove (moved to state/mod.rs)
├── dlmm.rs                   # Remove (moved to cpi/dlmm.rs)
└── instructions/
    └── mod.rs                # Update to re-export dlmm/ and damm/
```

### Test Files
```
tests/
├── octora-executor-damm-init.ts
├── octora-executor-damm-deposit.ts
├── octora-executor-damm-withdraw.ts
└── octora-executor-damm-claim-fees.ts
```

---

## Phase 1: Refactor Existing DLMM Code

### Task 1: Create state module with PoolAuthority

**Files:**
- Create: `programs/octora-executor/src/state/mod.rs`
- Create: `programs/octora-executor/src/state/pool_authority.rs`
- Modify: `programs/octora-executor/src/lib.rs` (add mod state)

- [ ] **Step 1: Create state/mod.rs**

```rust
pub mod pool_authority;

pub use pool_authority::*;
```

- [ ] **Step 2: Create state/pool_authority.rs with PoolRef enum**

```rust
use anchor_lang::prelude::*;

/// Pool-type-specific state reference.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum PoolRef {
    Dlmm {
        lb_pair: Pubkey,
        position: Pubkey,
    },
    Damm {
        pool: Pubkey,
        lp_mint: Pubkey,
        lock_escrow: Pubkey,
    },
}

/// PDA that owns a pool position on behalf of a stealth wallet.
#[account]
pub struct PoolAuthority {
    /// Stealth wallet that authorizes actions against this position.
    pub stealth_pubkey: Pubkey,
    
    /// Where withdrawal/claim proceeds are allowed to land.
    /// Immutable after init.
    pub exit_recipient: Pubkey,
    
    /// Pool-type-specific state.
    pub pool_ref: PoolRef,
    
    /// PDA bump.
    pub bump: u8,
}

impl PoolAuthority {
    pub const SPACE: usize = 8      // discriminator
        + 32                        // stealth_pubkey
        + 32                        // exit_recipient
        + 1                         // pool_ref enum tag
        + 32 + 32                   // DLMM: lb_pair + position (max variant)
        + 1;                        // bump
}
```

- [ ] **Step 3: Update lib.rs to add state module**

```rust
pub mod constants;
pub mod cpi;
pub mod errors;
pub mod instructions;
pub mod state;  // Add this line

use instructions::*;
```

- [ ] **Step 4: Build to verify compilation**

Run: `cargo build -p octora-executor`
Expected: Compilation succeeds

- [ ] **Step 5: Commit**

```bash
git add programs/octora-executor/src/state/
git add programs/octora-executor/src/lib.rs
git commit -m "refactor(executor): add PoolAuthority state with PoolRef enum"
```

---

### Task 2: Create shared CPI primitives module

**Files:**
- Create: `programs/octora-executor/src/cpi/mod.rs`
- Modify: `programs/octora-executor/src/lib.rs`

- [ ] **Step 1: Create cpi/mod.rs with shared primitives**

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    hash,
    instruction::Instruction,
    program::invoke_signed,
};
use anchor_spl::token::spl_token::state::Account as SplTokenAccount;
use anchor_lang::solana_program::program_pack::Pack;

use crate::errors::ExecutorError;

/// Canonical SPL Token program ID.
pub const SPL_TOKEN_PROGRAM_ID: Pubkey = 
    pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/// Canonical Token-2022 program ID.
pub const SPL_TOKEN_2022_PROGRAM_ID: Pubkey = 
    pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// Reject anything other than SPL Token or Token-2022.
pub fn require_spl_token_program(ai: &AccountInfo) -> Result<()> {
    let k = ai.key();
    require!(
        k == SPL_TOKEN_PROGRAM_ID || k == SPL_TOKEN_2022_PROGRAM_ID,
        ExecutorError::InvalidTokenProgram,
    );
    Ok(())
}

/// Validate SPL token account owner matches expected.
pub fn require_token_account_owner(
    token_account: &AccountInfo,
    expected: &Pubkey,
) -> Result<()> {
    let data = token_account.try_borrow_data()?;
    let parsed = SplTokenAccount::unpack(&data)
        .map_err(|_| error!(ExecutorError::InvalidTokenAccount))?;
    require_keys_eq!(
        parsed.owner,
        *expected,
        ExecutorError::ExitRecipientMismatch
    );
    Ok(())
}

/// Compute Anchor instruction discriminator: sha256("global:<name>")[..8].
pub fn anchor_discriminator(ix_name: &str) -> [u8; 8] {
    let preimage = format!("global:{}", ix_name);
    let digest = hash::hash(preimage.as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest.to_bytes()[..8]);
    out
}

/// Build a CPI instruction with discriminator + args.
pub fn build_ix(
    program_id: Pubkey,
    ix_name: &str,
    accounts: Vec<anchor_lang::solana_program::instruction::AccountMeta>,
    args_bytes: Vec<u8>,
) -> Instruction {
    let mut data = Vec::with_capacity(8 + args_bytes.len());
    data.extend_from_slice(&anchor_discriminator(ix_name));
    data.extend_from_slice(&args_bytes);

    Instruction {
        program_id,
        accounts,
        data,
    }
}

/// Invoke a CPI with PDA signer seeds.
pub fn invoke_signed_ix(
    ix: &Instruction,
    account_infos: &[AccountInfo],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    invoke_signed(ix, account_infos, signer_seeds).map_err(Into::into)
}
```

- [ ] **Step 2: Update lib.rs to add cpi module**

```rust
pub mod constants;
pub mod cpi;     // Add this line
pub mod errors;
```

- [ ] **Step 3: Build to verify compilation**

Run: `cargo build -p octora-executor`
Expected: Compilation succeeds

- [ ] **Step 4: Commit**

```bash
git add programs/octora-executor/src/cpi/mod.rs
git add programs/octora-executor/src/lib.rs
git commit -m "refactor(executor): add shared CPI primitives module"
```

---

### Task 3: Create DLMM CPI module (extract from dlmm.rs)

**Files:**
- Create: `programs/octora-executor/src/cpi/dlmm.rs`
- Modify: `programs/octora-executor/src/cpi/mod.rs`

- [ ] **Step 1: Create cpi/dlmm.rs with DLMM-specific helpers**

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use super::{build_ix, invoke_signed_ix};
use crate::constants::DLMM_PROGRAM_ID;
use crate::errors::ExecutorError;

/// DLMM event authority PDA: [b"__event_authority"]
pub fn derive_dlmm_event_authority() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"__event_authority"], &DLMM_PROGRAM_ID)
}

/// Validate DLMM program ID.
pub fn require_dlmm_program(ai: &AccountInfo) -> Result<()> {
    require_keys_eq!(
        ai.key(),
        DLMM_PROGRAM_ID,
        ExecutorError::DlmmProgramMismatch
    );
    Ok(())
}

/// Validate DLMM event authority PDA.
pub fn require_dlmm_event_authority(ai: &AccountInfo) -> Result<()> {
    let (expected, _bump) = derive_dlmm_event_authority();
    require_keys_eq!(ai.key(), expected, ExecutorError::EventAuthorityMismatch);
    Ok(())
}

/// Build DLMM CPI instruction.
pub fn build_dlmm_ix(
    ix_name: &str,
    accounts: Vec<AccountMeta>,
    args_bytes: Vec<u8>,
) -> anchor_lang::solana_program::instruction::Instruction {
    build_ix(DLMM_PROGRAM_ID, ix_name, accounts, args_bytes)
}

/// Invoke DLMM CPI with PDA signer.
pub fn invoke_dlmm_signed(
    ix: &anchor_lang::solana_program::instruction::Instruction,
    account_infos: &[AccountInfo],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    invoke_signed_ix(ix, account_infos, signer_seeds)
}
```

- [ ] **Step 2: Update cpi/mod.rs to export dlmm**

```rust
pub mod dlmm;
// pub mod damm;  // Will add in Phase 2

pub use dlmm::*;

// ... existing shared primitives ...
```

- [ ] **Step 3: Build to verify compilation**

Run: `cargo build -p octora-executor`
Expected: Compilation succeeds

- [ ] **Step 4: Commit**

```bash
git add programs/octora-executor/src/cpi/
git commit -m "refactor(executor): add DLMM CPI module"
```

---

### Task 4: Move DLMM instructions to instructions/dlmm/

**Files:**
- Create: `programs/octora-executor/src/instructions/dlmm/mod.rs`
- Create: `programs/octora-executor/src/instructions/dlmm/init_position.rs`
- Create: `programs/octora-executor/src/instructions/dlmm/add_liquidity.rs`
- Create: `programs/octora-executor/src/instructions/dlmm/claim_fees.rs`
- Create: `programs/octora-executor/src/instructions/dlmm/withdraw_close.rs`
- Modify: `programs/octora-executor/src/instructions/mod.rs`

- [ ] **Step 1: Create instructions/dlmm/mod.rs**

```rust
pub mod add_liquidity;
pub mod claim_fees;
pub mod init_position;
pub mod withdraw_close;

#[allow(ambiguous_glob_reexports)]
pub use add_liquidity::*;
#[allow(ambiguous_glob_reexports)]
pub use claim_fees::*;
#[allow(ambiguous_glob_reexports)]
pub use init_position::*;
#[allow(ambiguous_glob_reexports)]
pub use withdraw_close::*;
```

- [ ] **Step 2: Move init_position.rs (copy from current instructions/)**

Copy `programs/octora-executor/src/instructions/init_position.rs` to `programs/octora-executor/src/instructions/dlmm/init_position.rs`

Update imports at top of file:
```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::*;
use crate::cpi::dlmm::*;  // Updated import
use crate::errors::ExecutorError;
use crate::state::PoolAuthority;  // Updated import
use crate::state::PoolRef;  // Add for pool_ref matching
```

- [ ] **Step 3: Move remaining DLMM instruction files**

Repeat for:
- `add_liquidity.rs` → `dlmm/add_liquidity.rs`
- `claim_fees.rs` → `dlmm/claim_fees.rs`
- `withdraw_close.rs` → `dlmm/withdraw_close.rs`

Update imports in each file to use new paths.

- [ ] **Step 4: Update instructions/mod.rs**

```rust
pub mod dlmm;
// pub mod damm;  // Will add in Phase 2

#[allow(ambiguous_glob_reexports)]
pub use dlmm::*;
```

- [ ] **Step 5: Build to verify compilation**

Run: `cargo build -p octora-executor`
Expected: Compilation succeeds

- [ ] **Step 6: Run existing tests**

Run: `anchor test --skip-local-validator` (or appropriate test command)
Expected: Existing DLMM tests pass

- [ ] **Step 7: Commit**

```bash
git add programs/octora-executor/src/instructions/
git commit -m "refactor(executor): move DLMM instructions to instructions/dlmm/"
```

---

### Task 5: Update constants.rs with DAMM program IDs and seeds

**Files:**
- Modify: `programs/octora-executor/src/constants.rs`

- [ ] **Step 1: Add DAMM constants to constants.rs**

```rust
use anchor_lang::prelude::*;

// === Program IDs ===

/// Meteora DLMM program on mainnet & devnet.
pub const DLMM_PROGRAM_ID: Pubkey = 
    pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

/// Meteora DAMM (Dynamic AMM) program.
pub const DAMM_PROGRAM_ID: Pubkey = 
    pubkey!("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB");

/// DAMM vault base key for deriving vault PDAs.
pub const VAULT_BASE_KEY: Pubkey = 
    pubkey!("HWzXGcGHy4tcpYfaRDCyLNzXqBTv3E6BttpCH2vJxArv");

// === PDA Seeds ===

/// Seed for PoolAuthority PDA (per-pool).
pub const POOL_AUTHORITY_SEED: &[u8] = b"pool-authority";

/// Legacy seed for backward compatibility (will be deprecated).
pub const POSITION_AUTHORITY_SEED: &[u8] = b"position-authority";

/// DAMM lock escrow seed.
pub const LOCK_ESCROW_SEED: &[u8] = b"lock_escrow";
```

- [ ] **Step 2: Build to verify compilation**

Run: `cargo build -p octora-executor`
Expected: Compilation succeeds

- [ ] **Step 3: Commit**

```bash
git add programs/octora-executor/src/constants.rs
git commit -m "feat(executor): add DAMM program IDs and new PDA seeds"
```

---

### Task 6: Update errors.rs with DAMM-specific errors

**Files:**
- Modify: `programs/octora-executor/src/errors.rs`

- [ ] **Step 1: Add DAMM errors to errors.rs**

```rust
use anchor_lang::prelude::*;

#[error_code]
pub enum ExecutorError {
    // Existing DLMM errors (0-10)
    #[msg("DLMM program account does not match the configured program ID")]
    DlmmProgramMismatch,

    #[msg("Position account passed in does not match PoolAuthority position")]
    PositionMismatch,

    #[msg("LB pair account passed in does not match PoolAuthority lb_pair")]
    LbPairMismatch,

    #[msg("Stealth signer does not match PoolAuthority stealth_pubkey")]
    StealthMismatch,

    #[msg("Token account owner does not match PoolAuthority exit_recipient")]
    ExitRecipientMismatch,

    #[msg("Failed to deserialize SPL token account")]
    InvalidTokenAccount,

    #[msg("Forwarded token_program is not SPL Token or Token-2022")]
    InvalidTokenProgram,

    #[msg("Forwarded system_program / rent sysvar mismatch")]
    InvalidSysAccount,

    #[msg("DLMM event_authority PDA mismatch — possible IDL drift")]
    EventAuthorityMismatch,

    #[msg("Argument out of range (bin id ordering or basis points)")]
    ArgOutOfRange,

    #[msg("Forwarded remaining_accounts list is too short for this instruction")]
    AccountsTooShort,

    // New DAMM errors (11-17)
    #[msg("DAMM program account does not match the configured program ID")]
    DammProgramMismatch,

    #[msg("DAMM pool account does not match PoolAuthority pool")]
    DammPoolMismatch,

    #[msg("Lock escrow account does not match PoolAuthority lock_escrow")]
    LockEscrowMismatch,

    #[msg("Vault program mismatch")]
    VaultProgramMismatch,

    #[msg("PoolRef type does not match instruction (DLMM vs DAMM)")]
    InvalidPoolRefType,
}
```

- [ ] **Step 2: Build to verify compilation**

Run: `cargo build -p octora-executor`
Expected: Compilation succeeds

- [ ] **Step 3: Commit**

```bash
git add programs/octora-executor/src/errors.rs
git commit -m "feat(executor): add DAMM-specific errors"
```

---

## Phase 2: Add DAMM CPI Layer

### Task 7: Create DAMM CPI module

**Files:**
- Create: `programs/octora-executor/src/cpi/damm.rs`
- Modify: `programs/octora-executor/src/cpi/mod.rs`

- [ ] **Step 1: Create cpi/damm.rs**

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use super::{build_ix, invoke_signed_ix};
use crate::constants::{DAMM_PROGRAM_ID, LOCK_ESCROW_SEED};
use crate::errors::ExecutorError;

/// DAMM lock escrow PDA: [b"lock_escrow", pool, owner]
pub fn derive_lock_escrow(pool: &Pubkey, owner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[LOCK_ESCROW_SEED, pool.as_ref(), owner.as_ref()],
        &DAMM_PROGRAM_ID,
    )
}

/// Validate DAMM program ID.
pub fn require_damm_program(ai: &AccountInfo) -> Result<()> {
    require_keys_eq!(
        ai.key(),
        DAMM_PROGRAM_ID,
        ExecutorError::DammProgramMismatch
    );
    Ok(())
}

/// Build DAMM CPI instruction.
pub fn build_damm_ix(
    ix_name: &str,
    accounts: Vec<AccountMeta>,
    args_bytes: Vec<u8>,
) -> anchor_lang::solana_program::instruction::Instruction {
    build_ix(DAMM_PROGRAM_ID, ix_name, accounts, args_bytes)
}

/// Invoke DAMM CPI with PDA signer.
pub fn invoke_damm_signed(
    ix: &anchor_lang::solana_program::instruction::Instruction,
    account_infos: &[AccountInfo],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    invoke_signed_ix(ix, account_infos, signer_seeds)
}

/// Serialize addBalanceLiquidity args.
pub fn serialize_add_balance_liquidity_args(
    pool_token_amount: u64,
    max_token_a: u64,
    max_token_b: u64,
) -> Vec<u8> {
    let mut args = Vec::with_capacity(24);
    args.extend_from_slice(&pool_token_amount.to_le_bytes());
    args.extend_from_slice(&max_token_a.to_le_bytes());
    args.extend_from_slice(&max_token_b.to_le_bytes());
    args
}

/// Serialize removeBalanceLiquidity args.
pub fn serialize_remove_balance_liquidity_args(
    pool_token_amount: u64,
    min_token_a_out: u64,
    min_token_b_out: u64,
) -> Vec<u8> {
    let mut args = Vec::with_capacity(24);
    args.extend_from_slice(&pool_token_amount.to_le_bytes());
    args.extend_from_slice(&min_token_a_out.to_le_bytes());
    args.extend_from_slice(&min_token_b_out.to_le_bytes());
    args
}

/// Serialize claimFee args.
pub fn serialize_claim_fee_args(max_amount: u64) -> Vec<u8> {
    let mut args = Vec::with_capacity(8);
    args.extend_from_slice(&max_amount.to_le_bytes());
    args
}

/// Serialize lock args.
pub fn serialize_lock_args(max_amount: u64) -> Vec<u8> {
    let mut args = Vec::with_capacity(8);
    args.extend_from_slice(&max_amount.to_le_bytes());
    args
}
```

- [ ] **Step 2: Update cpi/mod.rs to export damm**

```rust
pub mod dlmm;
pub mod damm;

pub use dlmm::*;
pub use damm::*;

// ... existing shared primitives ...
```

- [ ] **Step 3: Build to verify compilation**

Run: `cargo build -p octora-executor`
Expected: Compilation succeeds

- [ ] **Step 4: Commit**

```bash
git add programs/octora-executor/src/cpi/
git commit -m "feat(executor): add DAMM CPI module with serialization helpers"
```

---

## Phase 3: Add DAMM Instructions

### Task 8: Create DAMM instructions module structure

**Files:**
- Create: `programs/octora-executor/src/instructions/damm/mod.rs`
- Modify: `programs/octora-executor/src/instructions/mod.rs`

- [ ] **Step 1: Create instructions/damm/mod.rs**

```rust
pub mod claim_fees;
pub mod deposit;
pub mod init;
pub mod withdraw;

#[allow(ambiguous_glob_reexports)]
pub use claim_fees::*;
#[allow(ambiguous_glob_reexports)]
pub use deposit::*;
#[allow(ambiguous_glob_reexports)]
pub use init::*;
#[allow(ambiguous_glob_reexports)]
pub use withdraw::*;
```

- [ ] **Step 2: Update instructions/mod.rs**

```rust
pub mod damm;
pub mod dlmm;

#[allow(ambiguous_glob_reexports)]
pub use damm::*;
#[allow(ambiguous_glob_reexports)]
pub use dlmm::*;
```

- [ ] **Step 3: Commit**

```bash
git add programs/octora-executor/src/instructions/
git commit -m "feat(executor): add DAMM instructions module structure"
```

---

### Task 9: Implement damm_init instruction

**Files:**
- Create: `programs/octora-executor/src/instructions/damm/init.rs`

- [ ] **Step 1: Create instructions/damm/init.rs**

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::*;
use crate::cpi::damm::*;
use crate::cpi::{require_spl_token_program, SPL_TOKEN_PROGRAM_ID};
use crate::errors::ExecutorError;
use crate::state::{PoolAuthority, PoolRef};

/// Initialize a DAMM position: create PoolAuthority + lock escrow.
#[derive(Accounts)]
pub struct DammInit<'info> {
    #[account(mut)]
    pub stealth: Signer<'info>,

    #[account(
        init,
        payer = stealth,
        space = PoolAuthority::SPACE,
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), pool.key().as_ref()],
        bump,
    )]
    pub pool_authority: Account<'info, PoolAuthority>,

    /// DAMM pool account.
    /// CHECK: Validated in handler against expected DAMM pool structure.
    pub pool: AccountInfo<'info>,

    /// LP mint of the pool.
    /// CHECK: Validated in handler.
    pub lp_mint: AccountInfo<'info>,

    /// Lock escrow PDA: [b"lock_escrow", pool, pool_authority]
    /// Created via CPI to DAMM's `lock` instruction.
    /// CHECK: Created by DAMM program via CPI.
    pub lock_escrow: AccountInfo<'info>,

    /// Escrow vault token account (holds locked LP tokens).
    /// CHECK: Passed to DAMM lock instruction.
    pub escrow_vault: AccountInfo<'info>,

    /// Source LP token account (PDA-owned, will be locked).
    /// CHECK: Passed to DAMM lock instruction.
    pub source_tokens: AccountInfo<'info>,

    /// DAMM program.
    /// CHECK: Validated in handler.
    pub damm_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, anchor_spl::token::Token>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DammInit<'info>>,
    exit_recipient: Pubkey,
) -> Result<()> {
    // Validate DAMM program
    require_damm_program(&ctx.accounts.damm_program)?;

    // Validate token program
    require_spl_token_program(&ctx.accounts.token_program)?;

    // Store state in PoolAuthority
    let pa = &mut ctx.accounts.pool_authority;
    pa.stealth_pubkey = ctx.accounts.stealth.key();
    pa.exit_recipient = exit_recipient;
    pa.pool_ref = PoolRef::Damm {
        pool: ctx.accounts.pool.key(),
        lp_mint: ctx.accounts.lp_mint.key(),
        lock_escrow: ctx.accounts.lock_escrow.key(),
    };
    pa.bump = ctx.bumps.pool_authority;

    // CPI to DAMM's `lock` instruction to create lock escrow with 0 amount
    // This sets up the escrow for future deposits
    let pa_key = pa.key();
    let stealth_key = ctx.accounts.stealth.key();
    let pool_key = ctx.accounts.pool.key();
    let bump = pa.bump;

    let signer_seeds: &[&[&[u8]]] = &[
        &[
            POOL_AUTHORITY_SEED,
            stealth_key.as_ref(),
            pool_key.as_ref(),
            &[bump],
        ],
    ];

    // Build lock instruction accounts
    // lock ix accounts: pool, lpMint, lockEscrow, owner, sourceTokens, escrowVault, tokenProgram,
    //                   aVault, bVault, aVaultLp, bVaultLp, aVaultLpMint, bVaultLpMint
    let accounts: Vec<AccountMeta> = vec![
        AccountMeta { pubkey: ctx.accounts.pool.key(), is_signer: false, is_writable: true },
        AccountMeta { pubkey: ctx.accounts.lp_mint.key(), is_signer: false, is_writable: true },
        AccountMeta { pubkey: ctx.accounts.lock_escrow.key(), is_signer: false, is_writable: true },
        AccountMeta { pubkey: pa_key, is_signer: true, is_writable: false },  // owner = PDA
        AccountMeta { pubkey: ctx.accounts.source_tokens.key(), is_signer: false, is_writable: true },
        AccountMeta { pubkey: ctx.accounts.escrow_vault.key(), is_signer: false, is_writable: true },
        AccountMeta { pubkey: ctx.accounts.token_program.key(), is_signer: false, is_writable: false },
        // Additional vault accounts would be passed via remaining_accounts
    ];

    // Note: For initial lock with 0 amount, we need all vault accounts
    // These should be passed via remaining_accounts
    let remaining = ctx.remaining_accounts;
    let mut all_accounts: Vec<AccountMeta> = accounts;
    for ai in remaining {
        all_accounts.push(AccountMeta {
            pubkey: ai.key(),
            is_signer: ai.is_signer,
            is_writable: ai.is_writable,
        });
    }

    let ix = build_damm_ix("lock", all_accounts, serialize_lock_args(0));
    invoke_damm_signed(&ix, remaining, signer_seeds)?;

    msg!(
        "damm_init: stealth={} pa={} pool={} lock_escrow={}",
        stealth_key,
        pa_key,
        pool_key,
        ctx.accounts.lock_escrow.key(),
    );

    Ok(())
}
```

- [ ] **Step 2: Build to verify compilation**

Run: `cargo build -p octora-executor`
Expected: Compilation succeeds

- [ ] **Step 3: Commit**

```bash
git add programs/octora-executor/src/instructions/damm/init.rs
git commit -m "feat(executor): implement damm_init instruction"
```

---

### Task 10: Implement damm_deposit instruction

**Files:**
- Create: `programs/octora-executor/src/instructions/damm/deposit.rs`

- [ ] **Step 1: Create instructions/damm/deposit.rs**

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::*;
use crate::cpi::damm::*;
use crate::cpi::{require_spl_token_program};
use crate::errors::ExecutorError;
use crate::state::{PoolAuthority, PoolRef};

/// Add single-side liquidity (SOL) to DAMM pool.
#[derive(Accounts)]
pub struct DammDeposit<'info> {
    pub stealth: Signer<'info>,

    #[account(
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), pool.key().as_ref()],
        bump = pool_authority.bump,
        constraint = pool_authority.stealth_pubkey == stealth.key()
            @ ExecutorError::StealthMismatch,
    )]
    pub pool_authority: Account<'info, PoolAuthority>,

    /// DAMM pool account.
    pub pool: AccountInfo<'info>,

    /// DAMM program.
    /// CHECK: Validated in handler.
    pub damm_program: UncheckedAccount<'info>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DammDeposit<'info>>,
    pool_token_amount: u64,
    max_sol: u64,
    max_quote: u64,
) -> Result<()> {
    // Validate DAMM program
    require_damm_program(&ctx.accounts.damm_program)?;

    let pa = &ctx.accounts.pool_authority;
    let remaining = ctx.remaining_accounts;

    // Validate PoolRef is DAMM
    let (stored_pool, stored_lp_mint, stored_lock_escrow) = match &pa.pool_ref {
        PoolRef::Damm { pool, lp_mint, lock_escrow } => (*pool, *lp_mint, *lock_escrow),
        _ => return Err(error!(ExecutorError::InvalidPoolRefType)),
    };

    // Validate pool matches
    require_keys_eq!(
        ctx.accounts.pool.key(),
        stored_pool,
        ExecutorError::DammPoolMismatch
    );

    // Remaining accounts for addBalanceLiquidity (14 accounts):
    // 0. pool (W), 1. lpMint (W), 2. userPoolLp (W), 3. aVaultLpMint (W),
    // 4. bVaultLpMint (W), 5. userSolToken (W), 6. bVaultLp (W),
    // 7. aVault (W), 8. bVault (W), 9. aTokenVault (W), 10. bTokenVault (W),
    // 11. userQuoteToken (W), 12. user (S) -> re-pinned to PDA,
    // 13. vaultProgram, 14. tokenProgram

    require!(remaining.len() >= 15, ExecutorError::AccountsTooShort);

    // Validate token program
    require_spl_token_program(&remaining[14])?;

    // Re-pin user (index 12) to PDA signer
    let pa_key = pa.key();
    let stealth_key = ctx.accounts.stealth.key();
    let pool_key = ctx.accounts.pool.key();
    let bump = pa.bump;

    let signer_seeds: &[&[&[u8]]] = &[
        &[
            POOL_AUTHORITY_SEED,
            stealth_key.as_ref(),
            pool_key.as_ref(),
            &[bump],
        ],
    ];

    let metas: Vec<AccountMeta> = remaining
        .iter()
        .enumerate()
        .map(|(i, ai)| {
            if i == 12 {
                // Re-pin signer to PDA
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

    let args = serialize_add_balance_liquidity_args(pool_token_amount, max_sol, max_quote);
    let ix = build_damm_ix("addBalanceLiquidity", metas, args);
    invoke_damm_signed(&ix, remaining, signer_seeds)?;

    msg!(
        "damm_deposit: stealth={} pa={} pool={} amount={}",
        stealth_key,
        pa_key,
        pool_key,
        pool_token_amount,
    );

    Ok(())
}
```

- [ ] **Step 2: Build to verify compilation**

Run: `cargo build -p octora-executor`
Expected: Compilation succeeds

- [ ] **Step 3: Commit**

```bash
git add programs/octora-executor/src/instructions/damm/deposit.rs
git commit -m "feat(executor): implement damm_deposit instruction"
```

---

### Task 11: Implement damm_withdraw instruction

**Files:**
- Create: `programs/octora-executor/src/instructions/damm/withdraw.rs`

- [ ] **Step 1: Create instructions/damm/withdraw.rs**

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::*;
use crate::cpi::damm::*;
use crate::cpi::{require_spl_token_program, require_token_account_owner};
use crate::errors::ExecutorError;
use crate::state::{PoolAuthority, PoolRef};

/// Remove liquidity, close lock escrow, and close PoolAuthority.
#[derive(Accounts)]
pub struct DammWithdraw<'info> {
    #[account(mut)]
    pub stealth: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), pool.key().as_ref()],
        bump = pool_authority.bump,
        constraint = pool_authority.stealth_pubkey == stealth.key()
            @ ExecutorError::StealthMismatch,
        close = stealth,
    )]
    pub pool_authority: Account<'info, PoolAuthority>,

    /// Lock escrow — closed during this instruction.
    /// Rent rebate goes to exit_recipient.
    /// CHECK: Closed by Anchor close constraint.
    #[account(
        mut,
        seeds = [LOCK_ESCROW_SEED, pool.key().as_ref(), pool_authority.key().as_ref()],
        bump,
        close = exit_recipient,
    )]
    pub lock_escrow: AccountInfo<'info>,

    /// Must match pool_authority.exit_recipient.
    /// CHECK: Validated in handler.
    #[account(mut)]
    pub exit_recipient: AccountInfo<'info>,

    /// DAMM pool account.
    pub pool: AccountInfo<'info>,

    /// DAMM program.
    /// CHECK: Validated in handler.
    pub damm_program: UncheckedAccount<'info>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DammWithdraw<'info>>,
    pool_token_amount: u64,
    min_sol_out: u64,
    min_quote_out: u64,
) -> Result<()> {
    // Validate DAMM program
    require_damm_program(&ctx.accounts.damm_program)?;

    let pa = &ctx.accounts.pool_authority;
    let remaining = ctx.remaining_accounts;

    // Validate PoolRef is DAMM
    let (stored_pool, _, stored_lock_escrow) = match &pa.pool_ref {
        PoolRef::Damm { pool, lp_mint: _, lock_escrow } => (*pool, *lock_escrow),
        _ => return Err(error!(ExecutorError::InvalidPoolRefType)),
    };

    // Validate pool matches
    require_keys_eq!(
        ctx.accounts.pool.key(),
        stored_pool,
        ExecutorError::DammPoolMismatch
    );

    // Validate lock_escrow matches
    require_keys_eq!(
        ctx.accounts.lock_escrow.key(),
        stored_lock_escrow,
        ExecutorError::LockEscrowMismatch
    );

    // Remaining accounts for removeBalanceLiquidity (15 accounts):
    // 0. pool (W), 1. lpMint (W), 2. userPoolLp (W), 3. aVaultLp (W),
    // 4. bVaultLp (W), 5. aVault (W), 6. bVault (W), 7. aVaultLpMint (W),
    // 8. bVaultLpMint (W), 9. aTokenVault (W), 10. bTokenVault (W),
    // 11. userSolToken (W) -> owner = exit_recipient,
    // 12. userQuoteToken (W) -> owner = exit_recipient,
    // 13. user (S) -> re-pinned to PDA, 14. vaultProgram, 15. tokenProgram

    require!(remaining.len() >= 16, ExecutorError::AccountsTooShort);

    // Validate destination token accounts owned by exit_recipient
    require_token_account_owner(&remaining[11], &pa.exit_recipient)?;
    require_token_account_owner(&remaining[12], &pa.exit_recipient)?;

    // Validate token program
    require_spl_token_program(&remaining[15])?;

    // Re-pin user (index 13) to PDA signer
    let pa_key = pa.key();
    let stealth_key = ctx.accounts.stealth.key();
    let pool_key = ctx.accounts.pool.key();
    let bump = pa.bump;

    let signer_seeds: &[&[&[u8]]] = &[
        &[
            POOL_AUTHORITY_SEED,
            stealth_key.as_ref(),
            pool_key.as_ref(),
            &[bump],
        ],
    ];

    let metas: Vec<AccountMeta> = remaining
        .iter()
        .enumerate()
        .map(|(i, ai)| {
            if i == 13 {
                // Re-pin signer to PDA
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

    let args = serialize_remove_balance_liquidity_args(pool_token_amount, min_sol_out, min_quote_out);
    let ix = build_damm_ix("removeBalanceLiquidity", metas, args);
    invoke_damm_signed(&ix, remaining, signer_seeds)?;

    msg!(
        "damm_withdraw: stealth={} pa={} pool={} amount={}",
        stealth_key,
        pa_key,
        pool_key,
        pool_token_amount,
    );

    // Note: lock_escrow and pool_authority closed automatically by Anchor close constraints

    Ok(())
}
```

- [ ] **Step 2: Build to verify compilation**

Run: `cargo build -p octora-executor`
Expected: Compilation succeeds

- [ ] **Step 3: Commit**

```bash
git add programs/octora-executor/src/instructions/damm/withdraw.rs
git commit -m "feat(executor): implement damm_withdraw instruction with lock escrow closure"
```

---

### Task 12: Implement damm_claim_fees instruction

**Files:**
- Create: `programs/octora-executor/src/instructions/damm/claim_fees.rs`

- [ ] **Step 1: Create instructions/damm/claim_fees.rs**

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;

use crate::constants::*;
use crate::cpi::damm::*;
use crate::cpi::{require_spl_token_program, require_token_account_owner};
use crate::errors::ExecutorError;
use crate::state::{PoolAuthority, PoolRef};

/// Claim fees from locked LP position.
#[derive(Accounts)]
pub struct DammClaimFees<'info> {
    pub stealth: Signer<'info>,

    #[account(
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), pool.key().as_ref()],
        bump = pool_authority.bump,
        constraint = pool_authority.stealth_pubkey == stealth.key()
            @ ExecutorError::StealthMismatch,
    )]
    pub pool_authority: Account<'info, PoolAuthority>,

    /// DAMM pool account.
    pub pool: AccountInfo<'info>,

    /// DAMM program.
    /// CHECK: Validated in handler.
    pub damm_program: UncheckedAccount<'info>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, DammClaimFees<'info>>,
    max_amount: u64,
) -> Result<()> {
    // Validate DAMM program
    require_damm_program(&ctx.accounts.damm_program)?;

    let pa = &ctx.accounts.pool_authority;
    let remaining = ctx.remaining_accounts;

    // Validate PoolRef is DAMM
    let (stored_pool, _, stored_lock_escrow) = match &pa.pool_ref {
        PoolRef::Damm { pool, lp_mint: _, lock_escrow } => (*pool, *lock_escrow),
        _ => return Err(error!(ExecutorError::InvalidPoolRefType)),
    };

    // Validate pool matches
    require_keys_eq!(
        ctx.accounts.pool.key(),
        stored_pool,
        ExecutorError::DammPoolMismatch
    );

    // Remaining accounts for claimFee (17 accounts):
    // 0. pool (W), 1. lpMint (W), 2. lockEscrow (W), 3. owner (S) -> re-pinned to PDA,
    // 4. sourceTokens (W), 5. escrowVault (W), 6. tokenProgram,
    // 7. aTokenVault (W), 8. bTokenVault (W), 9. aVault (W), 10. bVault (W),
    // 11. aVaultLp (W), 12. bVaultLp (W), 13. aVaultLpMint (W), 14. bVaultLpMint (W),
    // 15. userSolToken (W) -> owner = exit_recipient,
    // 16. userQuoteToken (W) -> owner = exit_recipient, 17. vaultProgram

    require!(remaining.len() >= 18, ExecutorError::AccountsTooShort);

    // Validate lock_escrow matches
    require_keys_eq!(
        remaining[2].key(),
        stored_lock_escrow,
        ExecutorError::LockEscrowMismatch
    );

    // Validate destination token accounts owned by exit_recipient
    require_token_account_owner(&remaining[15], &pa.exit_recipient)?;
    require_token_account_owner(&remaining[16], &pa.exit_recipient)?;

    // Validate token program
    require_spl_token_program(&remaining[6])?;

    // Re-pin owner (index 3) to PDA signer
    let pa_key = pa.key();
    let stealth_key = ctx.accounts.stealth.key();
    let pool_key = ctx.accounts.pool.key();
    let bump = pa.bump;

    let signer_seeds: &[&[&[u8]]] = &[
        &[
            POOL_AUTHORITY_SEED,
            stealth_key.as_ref(),
            pool_key.as_ref(),
            &[bump],
        ],
    ];

    let metas: Vec<AccountMeta> = remaining
        .iter()
        .enumerate()
        .map(|(i, ai)| {
            if i == 3 {
                // Re-pin signer to PDA
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

    let args = serialize_claim_fee_args(max_amount);
    let ix = build_damm_ix("claimFee", metas, args);
    invoke_damm_signed(&ix, remaining, signer_seeds)?;

    msg!(
        "damm_claim_fees: stealth={} pa={} pool={}",
        stealth_key,
        pa_key,
        pool_key,
    );

    Ok(())
}
```

- [ ] **Step 2: Build to verify compilation**

Run: `cargo build -p octora-executor`
Expected: Compilation succeeds

- [ ] **Step 3: Commit**

```bash
git add programs/octora-executor/src/instructions/damm/claim_fees.rs
git commit -m "feat(executor): implement damm_claim_fees instruction"
```

---

### Task 13: Add DAMM entrypoints to lib.rs

**Files:**
- Modify: `programs/octora-executor/src/lib.rs`

- [ ] **Step 1: Add DAMM instruction entrypoints to lib.rs**

Update the `#[program]` module in `lib.rs`:

```rust
#[program]
pub mod octora_executor {
    use super::*;

    // === DLMM Instructions ===

    pub fn dlmm_init_position<'info>(
        ctx: Context<'_, '_, '_, 'info, instructions::dlmm::InitPosition<'info>>,
        lower_bin_id: i32,
        width: i32,
        exit_recipient: Pubkey,
    ) -> Result<()> {
        instructions::dlmm::init_position::handler(ctx, lower_bin_id, width, exit_recipient)
    }

    pub fn dlmm_add_liquidity<'info>(
        ctx: Context<'_, '_, '_, 'info, instructions::dlmm::AddLiquidity<'info>>,
        liquidity_params: Vec<u8>,
    ) -> Result<()> {
        instructions::dlmm::add_liquidity::handler(ctx, liquidity_params)
    }

    pub fn dlmm_claim_fees<'info>(
        ctx: Context<'_, '_, '_, 'info, instructions::dlmm::ClaimFees<'info>>,
    ) -> Result<()> {
        instructions::dlmm::claim_fees::handler(ctx)
    }

    pub fn dlmm_withdraw_close<'info>(
        ctx: Context<'_, '_, '_, 'info, instructions::dlmm::WithdrawClose<'info>>,
        from_bin_id: i32,
        to_bin_id: i32,
        bps_to_remove: u16,
    ) -> Result<()> {
        instructions::dlmm::withdraw_close::handler(ctx, from_bin_id, to_bin_id, bps_to_remove)
    }

    // === DAMM Instructions ===

    pub fn damm_init<'info>(
        ctx: Context<'_, '_, '_, 'info, instructions::damm::DammInit<'info>>,
        exit_recipient: Pubkey,
    ) -> Result<()> {
        instructions::damm::init::handler(ctx, exit_recipient)
    }

    pub fn damm_deposit<'info>(
        ctx: Context<'_, '_, '_, 'info, instructions::damm::DammDeposit<'info>>,
        pool_token_amount: u64,
        max_sol: u64,
        max_quote: u64,
    ) -> Result<()> {
        instructions::damm::deposit::handler(ctx, pool_token_amount, max_sol, max_quote)
    }

    pub fn damm_withdraw<'info>(
        ctx: Context<'_, '_, '_, 'info, instructions::damm::DammWithdraw<'info>>,
        pool_token_amount: u64,
        min_sol_out: u64,
        min_quote_out: u64,
    ) -> Result<()> {
        instructions::damm::withdraw::handler(ctx, pool_token_amount, min_sol_out, min_quote_out)
    }

    pub fn damm_claim_fees<'info>(
        ctx: Context<'_, '_, '_, 'info, instructions::damm::DammClaimFees<'info>>,
        max_amount: u64,
    ) -> Result<()> {
        instructions::damm::claim_fees::handler(ctx, max_amount)
    }
}
```

- [ ] **Step 2: Build to verify compilation**

Run: `cargo build -p octora-executor`
Expected: Compilation succeeds

- [ ] **Step 3: Commit**

```bash
git add programs/octora-executor/src/lib.rs
git commit -m "feat(executor): add DAMM instruction entrypoints"
```

---

## Phase 4: Testing

### Task 14: Add DAMM fixture to Anchor.toml

**Files:**
- Modify: `Anchor.toml`

- [ ] **Step 1: Add DAMM program to test genesis**

```toml
[[test.genesis]]
address = "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"
program = "tests/fixtures/meteora_damm.so"
```

- [ ] **Step 2: Add DAMM pool clone for testing**

```toml
[[test.validator.clone]]
address = "32D4zRxNc1EssbJieVHfPhZM3rH6CzfUPrWUuWxD9prG"  # USDT/USDC DAMM pool
```

- [ ] **Step 3: Commit**

```bash
git add Anchor.toml
git commit -m "test(executor): add DAMM fixture to Anchor.toml"
```

---

### Task 15: Create DAMM init test

**Files:**
- Create: `tests/octora-executor-damm-init.ts`

- [ ] **Step 1: Create DAMM init test file**

```typescript
/**
 * DAMM init instruction test.
 * 
 * Tests PoolAuthority + lock escrow creation for DAMM pools.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";

const POOL_AUTHORITY_SEED = Buffer.from("pool-authority");
const LOCK_ESCROW_SEED = Buffer.from("lock_escrow");
const DAMM_PROGRAM_ID = new PublicKey("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB");

describe("octora-executor :: damm_init", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.octoraExecutor as Program;
  const payer = provider.wallet as anchor.Wallet;

  it("creates PoolAuthority and lock escrow for DAMM pool", async () => {
    // Test implementation here
    // 1. Create stealth keypair
    // 2. Call damm_init
    // 3. Verify PoolAuthority created with correct PoolRef::Damm
    // 4. Verify lock escrow exists
  });

  it("fails if DAMM program mismatch", async () => {
    // Test with wrong DAMM program ID
  });

  it("fails if token program is not SPL Token or Token-2022", async () => {
    // Test with invalid token program
  });
});
```

- [ ] **Step 2: Implement test logic**

Fill in the test implementations for each test case.

- [ ] **Step 3: Run test**

Run: `anchor test --skip-local-validator tests/octora-executor-damm-init.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/octora-executor-damm-init.ts
git commit -m "test(executor): add DAMM init instruction tests"
```

---

### Task 16: Create DAMM deposit test

**Files:**
- Create: `tests/octora-executor-damm-deposit.ts`

- [ ] **Step 1: Create DAMM deposit test file**

```typescript
/**
 * DAMM deposit instruction test.
 * 
 * Tests single-side liquidity deposit (SOL only).
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";

describe("octora-executor :: damm_deposit", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.octoraExecutor as Program;

  it("deposits SOL and mints LP tokens to PDA-owned ATA", async () => {
    // Test implementation
  });

  it("locks LP tokens after deposit", async () => {
    // Verify LP tokens locked in escrow
  });

  it("fails if PoolRef is DLMM", async () => {
    // Test with DLMM PoolAuthority
  });

  it("fails if pool mismatch", async () => {
    // Test with wrong pool
  });
});
```

- [ ] **Step 2: Implement test logic**

- [ ] **Step 3: Run test**

Run: `anchor test --skip-local-validator tests/octora-executor-damm-deposit.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/octora-executor-damm-deposit.ts
git commit -m "test(executor): add DAMM deposit instruction tests"
```

---

### Task 17: Create DAMM withdraw test

**Files:**
- Create: `tests/octora-executor-damm-withdraw.ts`

- [ ] **Step 1: Create DAMM withdraw test file**

```typescript
/**
 * DAMM withdraw instruction test.
 * 
 * Tests liquidity withdrawal, lock escrow closure, and PoolAuthority closure.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";

describe("octora-executor :: damm_withdraw", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.octoraExecutor as Program;

  it("withdraws liquidity and closes lock escrow and PoolAuthority", async () => {
    // Test implementation
  });

  it("sends tokens to exit_recipient ATAs", async () => {
    // Verify destination token owners
  });

  it("sends lock escrow rent to exit_recipient", async () => {
    // Verify rent rebate
  });

  it("sends PoolAuthority rent to stealth", async () => {
    // Verify rent rebate
  });

  it("fails if exit_recipient mismatch", async () => {
    // Test with wrong destination accounts
  });
});
```

- [ ] **Step 2: Implement test logic**

- [ ] **Step 3: Run test**

Run: `anchor test --skip-local-validator tests/octora-executor-damm-withdraw.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/octora-executor-damm-withdraw.ts
git commit -m "test(executor): add DAMM withdraw instruction tests"
```

---

### Task 18: Create DAMM claim fees test

**Files:**
- Create: `tests/octora-executor-damm-claim-fees.ts`

- [ ] **Step 1: Create DAMM claim fees test file**

```typescript
/**
 * DAMM claim fees instruction test.
 * 
 * Tests fee claiming from locked LP position.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";

describe("octora-executor :: damm_claim_fees", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.octoraExecutor as Program;

  it("claims fees to exit_recipient ATAs", async () => {
    // Test implementation
  });

  it("fails if lock escrow mismatch", async () => {
    // Test with wrong lock escrow
  });

  it("fails if destination owner mismatch", async () => {
    // Test with wrong destination accounts
  });
});
```

- [ ] **Step 2: Implement test logic**

- [ ] **Step 3: Run test**

Run: `anchor test --skip-local-validator tests/octora-executor-damm-claim-fees.ts`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/octora-executor-damm-claim-fees.ts
git commit -m "test(executor): add DAMM claim fees instruction tests"
```

---

## Phase 5: Documentation and Finalization

### Task 19: Update README.md

**Files:**
- Modify: `programs/octora-executor/README.md`

- [ ] **Step 1: Add DAMM section to README**

Update the README to document:
- DAMM program support
- New instruction set
- PoolRef enum
- Single-side LP flow
- Token-2022 support

- [ ] **Step 2: Commit**

```bash
git add programs/octora-executor/README.md
git commit -m "docs(executor): update README with DAMM support"
```

---

### Task 20: Update IDL and client

**Files:**
- Modify: `octora-api/src/modules/execution/clients/idl/octora_executor.json`
- Modify: `octora-api/src/modules/execution/clients/octora-executor.client.ts`

- [ ] **Step 1: Rebuild IDL**

Run: `anchor build`
This updates the IDL with new DAMM instructions.

- [ ] **Step 2: Copy updated IDL**

Copy `target/idl/octora_executor.json` to `octora-api/src/modules/execution/clients/idl/`

- [ ] **Step 3: Update client with DAMM methods**

Add DAMM client methods to `octora-executor.client.ts`:
- `buildDammInitIx`
- `buildDammDepositIx`
- `buildDammWithdrawIx`
- `buildDammClaimFeesIx`

- [ ] **Step 4: Commit**

```bash
git add octora-api/src/modules/execution/clients/
git commit -m "feat(api): update executor client with DAMM support"
```

---

### Task 21: Final integration test

**Files:**
- Create: `tests/octora-executor-damm-lifecycle.ts`

- [ ] **Step 1: Create full lifecycle test**

```typescript
/**
 * Full DAMM lifecycle test.
 * 
 * init → deposit → claim_fees → withdraw
 */

describe("octora-executor :: DAMM full lifecycle", () => {
  // Test full flow: init → deposit → (wait for fees) → claim → withdraw
  // Verify all state transitions and token flows
});
```

- [ ] **Step 2: Run all tests**

Run: `anchor test`
Expected: All DLMM and DAMM tests pass

- [ ] **Step 3: Final commit**

```bash
git add tests/octora-executor-damm-lifecycle.ts
git commit -m "test(executor): add DAMM full lifecycle integration test"
```

---

## Self-Review Checklist

After completing all tasks, verify:

- [ ] All DLMM instructions still work (backward compatible)
- [ ] All DAMM instructions work with test DAMM pool
- [ ] Token-2022 validation passes
- [ ] PoolRef enum correctly serializes/deserializes
- [ ] Lock escrow closure works in withdraw
- [ ] Exit recipient enforcement works for all outflows
- [ ] IDL updated and client methods added
- [ ] README documents both pool types
- [ ] No compiler warnings
- [ ] All tests pass
