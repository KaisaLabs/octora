# DLMM-Only Mainnet Design

## Goal

Prepare `octora-executor` for a first production/mainnet release that supports **DLMM only**.

DAMM is intentionally excluded from the mainnet v1 surface because its lock escrow lifecycle is not fully confirmed.

---

## Scope

Mainnet v1 exposes only these instructions:

```text
dlmm_init_position
dlmm_add_liquidity
dlmm_claim_fees
dlmm_withdraw_close
```

Mainnet v1 must not expose:

```text
damm_init
damm_deposit
damm_withdraw
damm_claim_fees
```

---

## Rationale

DLMM has a complete and understandable lifecycle:

```text
init position
→ add liquidity
→ claim fees
→ withdraw liquidity
→ close position
```

This maps cleanly to Octora’s security model:

```text
stealth signer authorizes
→ PoolAuthority PDA signs DLMM CPI
→ exit_recipient receives outflows
```

DAMM is deferred because its lock escrow lifecycle is unresolved. The visible DAMM IDL supports:

```text
createLockEscrow
lock
claimFee
```

…but no confirmed unlock or lock escrow close path. Shipping DAMM in mainnet v1 would create unnecessary stuck-funds risk.

---

## Mainnet v1 Architecture

### Public Program API

`programs/octora-executor/src/lib.rs` exposes only DLMM entrypoints.

DAMM entrypoints are removed from the `#[program]` module for mainnet v1.

### Instructions Module

`programs/octora-executor/src/instructions/mod.rs` re-exports only DLMM instructions.

DAMM source files may remain in the repository for future work, but must not be reachable through the public Anchor program API or generated IDL.

### State

The current `PoolAuthority` state remains:

```rust
pub struct PoolAuthority {
    pub stealth_pubkey: Pubkey,
    pub exit_recipient: Pubkey,
    pub pool_ref: PoolRef,
    pub bump: u8,
}
```

`PoolRef::Dlmm` is used for mainnet v1.

`PoolRef::Damm` may remain in the enum for future compatibility, but no mainnet v1 instruction can create or use a DAMM authority.

---

## Required DLMM Hardening

### 1. Explicit LB Pair Validation in Init

`dlmm_init_position` must validate that the top-level `lb_pair` account matches the forwarded DLMM CPI `lb_pair` account:

```rust
require_keys_eq!(
    ctx.accounts.lb_pair.key(),
    lb_pair_account.key(),
    ExecutorError::LbPairMismatch
);
```

### 2. Preserve Existing DLMM Security Invariants

All DLMM instructions must preserve:

- stealth signer gates every action
- PoolAuthority PDA signs DLMM CPI
- PoolAuthority PDA uses per-pool seeds:

```text
[pool-authority, stealth_pubkey, lb_pair]
```

- stored position is revalidated before CPI
- stored LB pair is revalidated before CPI
- DLMM program ID is validated
- DLMM event authority PDA is validated
- token program accounts are canonical SPL Token or Token-2022
- token outflow accounts are owned by `exit_recipient`
- `PoolAuthority` closes only after `dlmm_withdraw_close`

---

## IDL Requirement

The generated mainnet IDL must contain only DLMM instructions.

It must not contain DAMM instructions.

This prevents client code from accidentally calling unfinished DAMM paths.

---

## Testing Requirements

Before mainnet deployment, verify:

```bash
cargo fmt --check -p octora-executor
cargo build -p octora-executor
anchor build
anchor test
```

Required DLMM lifecycle tests:

```text
dlmm_init_position
dlmm_add_liquidity
dlmm_claim_fees
dlmm_withdraw_close
```

Required negative tests:

```text
wrong stealth signer fails
wrong PoolAuthority PDA fails
wrong LB pair fails
wrong position fails
wrong DLMM program fails
wrong event authority fails
wrong token program fails
claim to non-exit_recipient ATA fails
withdraw to non-exit_recipient ATA fails
invalid bps_to_remove fails
invalid bin range fails
```

Recommended Token-2022 tests:

```text
claim fees to Token-2022 token accounts
withdraw close to Token-2022 token accounts
invalid Token-2022 owner fails
```

---

## Deployment Policy

Mainnet v1 is branded as:

```text
Octora Executor v1: DLMM-only production executor
```

DAMM is deferred to a later version after its full lifecycle is confirmed and tested.

---

## Success Criteria

The DLMM-only mainnet build is ready when:

- DAMM instructions are absent from the IDL
- DLMM code builds and formats cleanly
- DLMM lifecycle succeeds on devnet
- DLMM negative tests pass
- Token-2022 owner validation is tested
- upgrade authority plan is documented
- deployment uses a dedicated mainnet keypair and production RPC
