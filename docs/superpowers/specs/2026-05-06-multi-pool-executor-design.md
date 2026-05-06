# Multi-Pool-Type Executor Design

**Date:** 2026-05-06
**Status:** Draft
**Scope:** Extend `octora-executor` to support both Meteora DLMM and DAMM pool types

---

## Problem Statement

The current `octora-executor` program only supports Meteora DLMM pools. The frontend (`octora-web`) already displays both DLMM and DAMM pools in the pool browser, but the on-chain executor cannot interact with DAMM positions.

**DAMM vs DLMM structural differences:**

| Aspect | DLMM | DAMM |
|--------|------|------|
| Position model | Keypair account per position | LP token balance |
| Liquidity representation | Bins with amounts | LP token mint |
| Fee claiming | Per-position fee accounts | Via lock escrow (optional) |
| Key accounts | LbPair, Position, BinArray | Pool, LP mint, Vault A/B, LockEscrow |
| Program ID | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` |

---

## Design Goals

1. **Support both pool types** with unified security model (stealth authorizes → PDA signs → exit_recipient pins)
2. **Modular, maintainable code** following SOLID principles
3. **DRY** — shared CPI primitives, no duplicated validation logic
4. **Scalable** — easy to add more pool types later
5. **Type-safe** — impossible to misuse DLMM fields for DAMM positions

---

## Architecture

### File Structure

```
programs/octora-executor/src/
├── lib.rs                          # All program entrypoints (DLMM + DAMM)
├── constants.rs                    # Program IDs, seeds
├── errors.rs                       # Unified error enum
├── state/
│   ├── mod.rs
│   └── pool_authority.rs           # PoolAuthority with PoolRef enum
├── cpi/
│   ├── mod.rs                      # Shared primitives
│   ├── dlmm.rs                     # DLMM-specific CPI builders
│   └── damm.rs                     # DAMM-specific CPI builders
└── instructions/
    ├── mod.rs
    ├── dlmm/
    │   ├── mod.rs
    │   ├── init_position.rs        # Moved from current location
    │   ├── add_liquidity.rs
    │   ├── claim_fees.rs
    │   └── withdraw_close.rs
    └── damm/
        ├── mod.rs
        ├── init.rs                 # Create PA + lock escrow
        ├── deposit.rs              # addBalanceLiquidity
        ├── withdraw.rs             # removeBalanceLiquidity + close PA
        └── claim_fees.rs           # claimFee via lock escrow
```

---

## State Model

### PoolRef Enum

Tagged union capturing pool-type-specific state:

```rust
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
```

**Rationale:**
- Type-safe: impossible to read DLMM fields from DAMM position
- Self-documenting: enum variants make pool type explicit
- Borsh handles variable-size serialization cleanly
- Future pool types add new variants without breaking existing code

### PoolAuthority Account

Replaces current `PositionAuthority`:

```rust
#[account]
pub struct PoolAuthority {
    /// Stealth wallet that authorizes actions against this position
    pub stealth_pubkey: Pubkey,
    
    /// Where withdrawal/claim proceeds are allowed to land
    pub exit_recipient: Pubkey,
    
    /// Pool-type-specific state (DLMM or DAMM)
    pub pool_ref: PoolRef,
    
    /// PDA bump
    pub bump: u8,
}

impl PoolAuthority {
    pub const SPACE: usize = 8      // discriminator
        + 32                        // stealth_pubkey
        + 32                        // exit_recipient
        + 1                         // pool_ref enum tag
        + 32 + 32                   // DLMM: lb_pair + position (max)
        + 1;                        // bump
    // Note: DAMM variant is same size (pool + lp_mint + lock_escrow = 96 bytes)
}
```

### PDA Seeds

**Current (one position per stealth):**
```
[POSITION_AUTHORITY_SEED, stealth_pubkey]
```

**New (one position per pool):**
```
[POOL_AUTHORITY_SEED, stealth_pubkey, pool_pubkey]
```

Where `pool_pubkey` = `lb_pair` for DLMM, `pool` for DAMM.

**Benefits:**
- Multiple positions per stealth wallet (per-pool)
- Natural key for pool-type-specific operations
- Deterministic derivation from pool address

---

## CPI Layer

### Shared Primitives (`cpi/mod.rs`)

```rust
/// Compute Anchor instruction discriminator: sha256("global:<name>")[..8]
pub fn anchor_discriminator(ix_name: &str) -> [u8; 8];

/// Invoke a CPI with PDA signer seeds
pub fn invoke_signed_signed(
    ix: &Instruction,
    account_infos: &[AccountInfo],
    signer_seeds: &[&[&[u8]]],
) -> Result<()>;

/// Validate token program is canonical SPL Token or Token-2022
pub fn require_spl_token_program(ai: &AccountInfo) -> Result<()>;

/// Validate SPL token account owner matches expected
pub fn require_token_account_owner(
    token_account: &AccountInfo,
    expected: &Pubkey,
) -> Result<()>;

/// Validate system program
pub fn require_system_program(ai: &AccountInfo) -> Result<()>;

/// Validate rent sysvar
pub fn require_rent_sysvar(ai: &AccountInfo) -> Result<()>;
```

### DLMM CPI (`cpi/dlmm.rs`)

Extracted from current `dlmm.rs`:

```rust
pub const DLMM_PROGRAM_ID: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

/// DLMM event authority PDA: [b"__event_authority"]
pub fn derive_dlmm_event_authority() -> (Pubkey, u8);

/// Validate DLMM program ID
pub fn require_dlmm_program(ai: &AccountInfo) -> Result<()>;

/// Validate DLMM event authority PDA
pub fn require_dlmm_event_authority(ai: &AccountInfo) -> Result<()>;

/// Build DLMM CPI instruction
pub fn build_dlmm_ix(
    ix_name: &str,
    accounts: Vec<AccountMeta>,
    args_bytes: Vec<u8>,
) -> Instruction;

/// Invoke DLMM CPI with PDA signer
pub fn invoke_dlmm_signed(
    ix: &Instruction,
    account_infos: &[AccountInfo],
    signer_seeds: &[&[&[u8]]],
) -> Result<()>;
```

### DAMM CPI (`cpi/damm.rs`)

New module for DAMM interactions:

```rust
pub const DAMM_PROGRAM_ID: Pubkey = pubkey!("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB");

// Vault program used by DAMM for custody
// Vault program is derived from VAULT_BASE_KEY in DAMM SDK
// Base key: HWzXGcGHy4tcpYfaRDCyLNzXqBTv3E6BttpCH2vJxArv
// Actual vault program PDA derived per-token-mint
pub const VAULT_BASE_KEY: Pubkey = pubkey!("HWzXGcGHy4tcpYfaRDCyLNzXqBTv3E6BttpCH2vJxArv");

/// DAMM lock escrow PDA seeds: [b"lock_escrow", pool, owner]
pub const LOCK_ESCROW_SEED: &[u8] = b"lock_escrow";

/// Derive lock escrow PDA
pub fn derive_lock_escrow(pool: &Pubkey, owner: &Pubkey) -> (Pubkey, u8);

/// Validate DAMM program ID
pub fn require_damm_program(ai: &AccountInfo) -> Result<()>;

/// Validate vault program ID
pub fn require_vault_program(ai: &AccountInfo) -> Result<()>;

/// Build DAMM CPI instruction
pub fn build_damm_ix(
    ix_name: &str,
    accounts: Vec<AccountMeta>,
    args_bytes: Vec<u8>,
) -> Instruction;

/// Invoke DAMM CPI with PDA signer
pub fn invoke_damm_signed(
    ix: &Instruction,
    account_infos: &[AccountInfo],
    signer_seeds: &[&[&[u8]]],
) -> Result<()>;
```

---

## Instructions

### DLMM Instructions (existing, moved to `instructions/dlmm/`)

#### `dlmm_init_position`

**Purpose:** Create PoolAuthority PDA and initialize DLMM position.

**Entry:**
```rust
pub fn dlmm_init_position(
    ctx: Context<DlmmInitPosition>,
    lower_bin_id: i32,
    width: i32,
    exit_recipient: Pubkey,
) -> Result<()>;
```

**Accounts:**
- `stealth: Signer` — authorizer
- `pool_authority: Account<PoolAuthority>` — created here
- `dlmm_program: UncheckedAccount`
- `system_program: Program<System>`

**Remaining accounts:** Same as current (8 accounts for `initialize_position`)

**Changes from current:**
- Account type: `PositionAuthority` → `PoolAuthority`
- PDA seeds: include `lb_pair`
- Store `PoolRef::Dlmm { lb_pair, position }`

---

#### `dlmm_add_liquidity`

**Purpose:** Add liquidity to DLMM position via `add_liquidity_by_strategy`.

**Entry:**
```rust
pub fn dlmm_add_liquidity(
    ctx: Context<DlmmAddLiquidity>,
    liquidity_params: Vec<u8>,  // Borsh-encoded LiquidityParameterByStrategy
) -> Result<()>;
```

**Accounts:**
- `stealth: Signer`
- `pool_authority: Account<PoolAuthority>` — validates `PoolRef::Dlmm`
- `dlmm_program: UncheckedAccount`

**Remaining accounts:** 16 accounts for `add_liquidity_by_strategy`

**Validation:**
- `pool_authority.pool_ref` is `PoolRef::Dlmm`
- Forwarded position/lb_pair match stored values

---

#### `dlmm_claim_fees`

**Purpose:** Claim accrued fees from DLMM position.

**Entry:**
```rust
pub fn dlmm_claim_fees(ctx: Context<DlmmClaimFees>) -> Result<()>;
```

**Accounts:**
- `stealth: Signer`
- `pool_authority: Account<PoolAuthority>`
- `dlmm_program: UncheckedAccount`

**Remaining accounts:** 14 accounts for `claim_fee`

**Validation:**
- Destination token accounts owned by `exit_recipient`

---

#### `dlmm_withdraw_close`

**Purpose:** Remove liquidity and close DLMM position + PoolAuthority.

**Entry:**
```rust
pub fn dlmm_withdraw_close(
    ctx: Context<DlmmWithdrawClose>,
    from_bin_id: i32,
    to_bin_id: i32,
    bps_to_remove: u16,
) -> Result<()>;
```

**Accounts:**
- `stealth: Signer` (mut — receives rent rebate)
- `pool_authority: Account<PoolAuthority>` — closed via `close = stealth`
- `dlmm_program: UncheckedAccount`

**Remaining accounts:** 17 accounts for `remove_liquidity_by_range` + `close_position`

**Validation:**
- Destination token accounts owned by `exit_recipient`
- Rent receiver equals `exit_recipient`

---

### DAMM Instructions (new, in `instructions/damm/`)

#### `damm_init`

**Purpose:** Create PoolAuthority PDA + DAMM lock escrow for fee claiming.

**Entry:**
```rust
pub fn damm_init(
    ctx: Context<DammInit>,
    exit_recipient: Pubkey,
) -> Result<()>;
```

**Accounts:**
```rust
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
    
    /// DAMM pool account
    pub pool: AccountInfo<'info>,
    
    /// LP mint of the pool (read from pool state)
    /// CHECK: validated against pool.lpMint
    pub lp_mint: AccountInfo<'info>,
    
    /// Lock escrow PDA: [b"lock_escrow", pool, pool_authority]
    #[account(
        init,
        payer = stealth,
        space = LockEscrow::SPACE,
        seeds = [LOCK_ESCROW_SEED, pool.key().as_ref(), pool_authority.key().as_ref()],
        bump,
    )]
    pub lock_escrow: Account<'info, LockEscrow>,
    
    pub damm_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
```

**Handler logic:**
1. Validate `damm_program` matches `DAMM_PROGRAM_ID`
2. Derive lock escrow PDA
3. Store `PoolRef::Damm { pool, lp_mint, lock_escrow }`
4. Initialize `LockEscrow` state (delegated to DAMM via CPI if required)

**Note:** DAMM `lock` instruction creates the lock escrow. We CPI to it here.

---

#### `damm_deposit`

**Purpose:** Add balanced liquidity via DAMM `addBalanceLiquidity`.

**Entry:**
```rust
pub fn damm_deposit(
    ctx: Context<DammDeposit>,
    pool_token_amount: u64,      // LP tokens to mint
    max_token_a: u64,            // Max token A to deposit
    max_token_b: u64,            // Max token B to deposit
) -> Result<()>;
```

**Accounts:**
```rust
#[derive(Accounts)]
pub struct DammDeposit<'info> {
    pub stealth: Signer<'info>,
    
    #[account(
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), pool.key().as_ref()],
        bump = pool_authority.bump,
        constraint = pool_authority.stealth_pubkey == stealth.key(),
    )]
    pub pool_authority: Account<'info, PoolAuthority>,
    
    pub pool: AccountInfo<'info>,
    pub damm_program: UncheckedAccount<'info>,
}
```

**Remaining accounts (14 for `addBalanceLiquidity`):**

| Index | Account | Writable | Signer | Notes |
|-------|---------|----------|--------|-------|
| 0 | pool | ✓ | | |
| 1 | lpMint | ✓ | | |
| 2 | userPoolLp | ✓ | | PDA-owned ATA |
| 3 | aVaultLpMint | ✓ | | |
| 4 | bVaultLpMint | ✓ | | |
| 5 | userAToken | ✓ | | Source (PDA-owned) |
| 6 | bVaultLp | ✓ | | |
| 7 | aVault | ✓ | | |
| 8 | bVault | ✓ | | |
| 9 | aTokenVault | ✓ | | |
| 10 | bTokenVault | ✓ | | |
| 11 | userBToken | ✓ | | Source (PDA-owned) |
| 12 | user | | ✓ | Re-pinned to PDA |
| 13 | vaultProgram | | | |
| 14 | tokenProgram | | | Validated as SPL Token |

**Validation:**
- `pool_authority.pool_ref` is `PoolRef::Damm`
- Forwarded `pool` matches stored value
- `tokenProgram` is canonical SPL Token or Token-2022
- `user` (index 12) re-pinned to PDA signer

**CPI:**
- Build `addBalanceLiquidity` instruction
- Serialize args: `(pool_token_amount: u64, max_token_a: u64, max_token_b: u64)`
- Invoke with PDA signer seeds

---

#### `damm_withdraw`

**Purpose:** Remove balanced liquidity via DAMM `removeBalanceLiquidity` + close PoolAuthority.

**Entry:**
```rust
pub fn damm_withdraw(
    ctx: Context<DammWithdraw>,
    pool_token_amount: u64,      // LP tokens to burn
    min_token_a_out: u64,        // Min token A to receive
    min_token_b_out: u64,        // Min token B to receive
) -> Result<()>;
```

**Accounts:**
```rust
#[derive(Accounts)]
pub struct DammWithdraw<'info> {
    #[account(mut)]
    pub stealth: Signer<'info>,
    
    #[account(
        mut,
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), pool.key().as_ref()],
        bump = pool_authority.bump,
        constraint = pool_authority.stealth_pubkey == stealth.key(),
        close = stealth,
    )]
    pub pool_authority: Account<'info, PoolAuthority>,
    
    pub pool: AccountInfo<'info>,
    pub damm_program: UncheckedAccount<'info>,
}
```

**Remaining accounts (14 for `removeBalanceLiquidity`):**

| Index | Account | Writable | Signer | Notes |
|-------|---------|----------|--------|-------|
| 0 | pool | ✓ | | |
| 1 | lpMint | ✓ | | |
| 2 | userPoolLp | ✓ | | PDA-owned ATA |
| 3 | aVaultLp | ✓ | | |
| 4 | bVaultLp | ✓ | | |
| 5 | aVault | ✓ | | |
| 6 | bVault | ✓ | | |
| 7 | aVaultLpMint | ✓ | | |
| 8 | bVaultLpMint | ✓ | | |
| 9 | aTokenVault | ✓ | | |
| 10 | bTokenVault | ✓ | | |
| 11 | userAToken | ✓ | | Dest — owner = exit_recipient |
| 12 | userBToken | ✓ | | Dest — owner = exit_recipient |
| 13 | user | | ✓ | Re-pinned to PDA |
| 14 | vaultProgram | | | |
| 15 | tokenProgram | | | |

**Validation:**
- `userAToken` and `userBToken` owners equal `exit_recipient`
- `tokenProgram` is canonical
- Forwarded `pool` matches stored value

**CPI:**
- Build `removeBalanceLiquidity` instruction
- Serialize args: `(pool_token_amount: u64, min_token_a_out: u64, min_token_b_out: u64)`
- Invoke with PDA signer seeds

**Post-CPI:**
- PoolAuthority closed automatically via `close = stealth`
- Lock escrow remains (can be closed separately if needed)

---

#### `damm_claim_fees`

**Purpose:** Claim fees from locked LP position via DAMM `claimFee`.

**Entry:**
```rust
pub fn damm_claim_fees(
    ctx: Context<DammClaimFees>,
    max_amount: u64,
) -> Result<()>;
```

**Accounts:**
```rust
#[derive(Accounts)]
pub struct DammClaimFees<'info> {
    pub stealth: Signer<'info>,
    
    #[account(
        seeds = [POOL_AUTHORITY_SEED, stealth.key().as_ref(), pool.key().as_ref()],
        bump = pool_authority.bump,
        constraint = pool_authority.stealth_pubkey == stealth.key(),
    )]
    pub pool_authority: Account<'info, PoolAuthority>,
    
    pub pool: AccountInfo<'info>,
    pub damm_program: UncheckedAccount<'info>,
}
```

**Remaining accounts (17 for `claimFee`):**

| Index | Account | Writable | Signer | Notes |
|-------|---------|----------|--------|-------|
| 0 | pool | ✓ | | |
| 1 | lpMint | ✓ | | |
| 2 | lockEscrow | ✓ | | From PoolRef::Damm |
| 3 | owner | | ✓ | Re-pinned to PDA |
| 4 | sourceTokens | ✓ | | LP tokens |
| 5 | escrowVault | ✓ | | |
| 6 | tokenProgram | | | |
| 7 | aTokenVault | ✓ | | |
| 8 | bTokenVault | ✓ | | |
| 9 | aVault | ✓ | | |
| 10 | bVault | ✓ | | |
| 11 | aVaultLp | ✓ | | |
| 12 | bVaultLp | ✓ | | |
| 13 | aVaultLpMint | ✓ | | |
| 14 | bVaultLpMint | ✓ | | |
| 15 | userAToken | ✓ | | Dest — owner = exit_recipient |
| 16 | userBToken | ✓ | | Dest — owner = exit_recipient |
| 17 | vaultProgram | | | |

**Validation:**
- Forwarded `lockEscrow` matches `PoolRef::Damm.lock_escrow`
- `userAToken` and `userBToken` owners equal `exit_recipient`
- `tokenProgram` is canonical

**CPI:**
- Build `claimFee` instruction
- Serialize args: `(max_amount: u64)`
- Invoke with PDA signer seeds

---

## Error Handling

Extended error enum:

```rust
#[error_code]
pub enum ExecutorError {
    // Existing (0-10)
    DlmmProgramMismatch,
    PositionMismatch,
    LbPairMismatch,
    StealthMismatch,
    ExitRecipientMismatch,
    InvalidTokenAccount,
    InvalidTokenProgram,
    InvalidSysAccount,
    EventAuthorityMismatch,
    ArgOutOfRange,
    AccountsTooShort,
    
    // New DAMM errors (11-17)
    DammProgramMismatch,
    DammPoolMismatch,
    LockEscrowMismatch,
    VaultProgramMismatch,
    InvalidPoolRefType,      // Wrong pool type for instruction
    UnsupportedDammInstruction,
}
```

---

## Constants

Updated `constants.rs`:

```rust
use anchor_lang::prelude::*;

// === Program IDs ===
pub const DLMM_PROGRAM_ID: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
pub const DAMM_PROGRAM_ID: Pubkey = pubkey!("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB");

// === PDA Seeds ===
pub const POOL_AUTHORITY_SEED: &[u8] = b"pool-authority";
pub const LOCK_ESCROW_SEED: &[u8] = b"lock_escrow";

// === Token Programs ===
pub const SPL_TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SPL_TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
```

---

## Migration Path

### Backward Compatibility

**Renaming:**
- `PositionAuthority` → `PoolAuthority` (new account type)
- `POSITION_AUTHORITY_SEED` → `POOL_AUTHORITY_SEED`

**Existing positions:**
- Old positions (with old PDA seeds) will continue to work
- New positions use new seeds (per-pool)
- Both can coexist during transition

**Option A — Clean break (recommended):**
- Deploy new program version
- Old positions must be closed and recreated
- Simpler code, no migration complexity

**Option B — Support both:**
- Detect old vs new PDA seeds
- Dual code paths
- More complex, not recommended

**Recommendation:** Option A — clean break with version bump.

---

## Testing Strategy

### Unit Tests (per instruction)

- Mock account setups for DLMM and DAMM
- Validation logic (token program, exit recipient, pool matching)
- Error cases

### Integration Tests

1. **DLMM lifecycle** (existing)
   - init_position → add_liquidity → claim_fees → withdraw_close
   - Token flow validation
   - Exit recipient enforcement

2. **DAMM lifecycle** (new)
   - damm_init → damm_deposit → damm_claim_fees → damm_withdraw
   - Lock escrow creation
   - LP token minting/burning
   - Exit recipient enforcement

3. **Cross-type validation**
   - DLMM instruction on DAMM PoolAuthority → fails
   - DAMM instruction on DLMM PoolAuthority → fails

### Localnet Setup

Add to `Anchor.toml`:
```toml
[[test.genesis]]
address = "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"
program = "tests/fixtures/meteora_damm.so"
```

Clone DAMM pool accounts for testing:
```toml
[[test.validator.clone]]
address = "..."  # DAMM pool account
```

---

## Security Considerations

### Preserved Invariants

1. **Stealth wallet must authorize every action** — PDA seeds include stealth pubkey
2. **Pool authority is always the PDA** — signer slot re-pinned in CPI
3. **Forwarded pool accounts must match stored state** — prevents substitution
4. **Outflows pinned to exit_recipient** — token account owner validation
5. **Token program IDs pinned** — canonical SPL Token or Token-2022 only
6. **Pool-specific program IDs validated** — DLMM or DAMM only

### New Considerations

1. **DAMM lock escrow ownership**
   - Lock escrow is owned by DAMM program
   - `owner` field in lock escrow = PoolAuthority PDA
   - Only PoolAuthority PDA can claim fees

2. **LP token custody**
   - LP tokens minted to PDA-owned ATA
   - User cannot transfer LP tokens directly
   - Withdraw burns LP tokens via CPI

3. **Vault program interactions**
   - DAMM uses external vault program for custody
   - Vault program ID must be validated
   - CPI path: executor → DAMM → vault → token

---

## Open Questions

1. **Lock escrow creation flow** — DAMM's `lock` instruction creates the lock escrow. Need to confirm if we CPI to `lock` during `damm_init` with 0 amount, or if we create the escrow account separately first.

2. **Token-2022 support** — DAMM vault interactions with Token-2022 need verification. The vault program may have specific requirements.

3. **Lock escrow closure** — When closing PoolAuthority, should we also close the lock escrow? Currently left open.

---

## Implementation Phases

### Phase 1: Refactor existing code
- Extract shared CPI primitives to `cpi/mod.rs`
- Move DLMM CPI code to `cpi/dlmm.rs`
- Move instructions to `instructions/dlmm/`
- Rename `PositionAuthority` → `PoolAuthority`
- Update PDA seeds to per-pool

### Phase 2: Add DAMM CPI layer
- Create `cpi/damm.rs` with DAMM program constants
- Implement DAMM CPI builders

### Phase 3: Add DAMM instructions
- Create `instructions/damm/` module
- Implement `damm_init`
- Implement `damm_deposit`
- Implement `damm_withdraw`
- Implement `damm_claim_fees`

### Phase 4: Tests and documentation
- Update existing tests for new PDA seeds
- Add DAMM integration tests
- Update README with DAMM support

---

## References

- Meteora DLMM SDK: `@meteora-ag/dlmm`
- Meteora DAMM SDK: `@mercurial-finance/dynamic-amm-sdk`
- DLMM Program: `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`
- DAMM Program: `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB`
