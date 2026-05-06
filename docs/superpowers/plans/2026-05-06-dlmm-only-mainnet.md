# DLMM-Only Mainnet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a production-focused mainnet v1 of `octora-executor` that exposes only DLMM instructions.

**Architecture:** Remove DAMM from the public Anchor API/IDL while preserving source for later work. Harden DLMM init validation, verify the build/IDL surface, and document mainnet/deployment requirements.

**Tech Stack:** Anchor 0.30.1, Rust, Solana, Meteora DLMM CPI.

---

## File Structure

### Modify

- `programs/octora-executor/src/lib.rs` — remove DAMM program entrypoints from `#[program]`.
- `programs/octora-executor/src/instructions/mod.rs` — stop exporting DAMM instructions for mainnet v1.
- `programs/octora-executor/src/instructions/dlmm/init_position.rs` — add explicit `ctx.accounts.lb_pair == remaining[2]` validation.
- `programs/octora-executor/README.md` — document DLMM-only mainnet v1 and DAMM deferral.

### Verify / generated

- `target/idl/octora_executor.json` — after `anchor build`, must contain only DLMM instructions.

---

## Task 1: Remove DAMM from public program API

**Files:**
- Modify: `programs/octora-executor/src/lib.rs`

- [ ] **Step 1: Remove these DAMM entrypoints from `#[program]`**

Remove the whole DAMM block:

```rust
pub fn damm_init<'info>(...) -> Result<()> { ... }
pub fn damm_deposit<'info>(...) -> Result<()> { ... }
pub fn damm_withdraw<'info>(...) -> Result<()> { ... }
pub fn damm_claim_fees<'info>(...) -> Result<()> { ... }
```

Keep only:

```rust
pub fn dlmm_init_position<'info>(...) -> Result<()> { ... }
pub fn dlmm_add_liquidity<'info>(...) -> Result<()> { ... }
pub fn dlmm_claim_fees<'info>(...) -> Result<()> { ... }
pub fn dlmm_withdraw_close<'info>(...) -> Result<()> { ... }
```

- [ ] **Step 2: Build**

Run:

```bash
cargo build -p octora-executor
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add programs/octora-executor/src/lib.rs
git commit -m "feat(executor): expose DLMM-only mainnet API"
```

---

## Task 2: Stop exporting DAMM instructions

**Files:**
- Modify: `programs/octora-executor/src/instructions/mod.rs`

- [ ] **Step 1: Change exports to DLMM-only**

Replace the file with:

```rust
pub mod dlmm;

#[allow(ambiguous_glob_reexports)]
pub use dlmm::*;
```

Do not delete `instructions/damm/`; just make it unreachable from the public module tree.

- [ ] **Step 2: Build**

Run:

```bash
cargo build -p octora-executor
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add programs/octora-executor/src/instructions/mod.rs
git commit -m "feat(executor): exclude DAMM instructions from mainnet v1"
```

---

## Task 3: Harden DLMM init account validation

**Files:**
- Modify: `programs/octora-executor/src/instructions/dlmm/init_position.rs`

- [ ] **Step 1: Add explicit top-level lb_pair validation**

After:

```rust
let lb_pair_account = &remaining[2];
```

add:

```rust
require_keys_eq!(
    ctx.accounts.lb_pair.key(),
    lb_pair_account.key(),
    ExecutorError::LbPairMismatch
);
```

- [ ] **Step 2: Format/build**

Run:

```bash
cargo fmt -p octora-executor
cargo build -p octora-executor
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add programs/octora-executor/src/instructions/dlmm/init_position.rs
git commit -m "fix(executor): validate DLMM init lb_pair account"
```

---

## Task 4: Verify IDL is DLMM-only

**Files:**
- Generated: `target/idl/octora_executor.json`

- [ ] **Step 1: Build IDL**

Run:

```bash
anchor build
```

Expected: pass.

- [ ] **Step 2: Verify IDL instruction names**

Run:

```bash
node - <<'NODE'
const idl = require('./target/idl/octora_executor.json');
console.log(idl.instructions.map(ix => ix.name).join('\n'));
if (idl.instructions.some(ix => ix.name.startsWith('damm'))) {
  throw new Error('DAMM instruction leaked into mainnet IDL');
}
NODE
```

Expected output contains only:

```text
dlmmInitPosition
dlmmAddLiquidity
dlmmClaimFees
dlmmWithdrawClose
```

- [ ] **Step 3: Commit IDL only if project tracks generated IDL**

If tracked:

```bash
git add target/idl/octora_executor.json
git commit -m "build(executor): regenerate DLMM-only IDL"
```

If not tracked, skip commit.

---

## Task 5: Update executor README

**Files:**
- Modify: `programs/octora-executor/README.md`

- [ ] **Step 1: Add mainnet v1 section**

Add:

```markdown
## Mainnet v1 Scope

Octora Executor v1 is DLMM-only.

Exposed instructions:

- `dlmm_init_position`
- `dlmm_add_liquidity`
- `dlmm_claim_fees`
- `dlmm_withdraw_close`

DAMM is deferred until its lock escrow lifecycle is fully confirmed and tested. DAMM source may exist in the repository, but DAMM instructions are not exposed in the mainnet v1 IDL.
```

- [ ] **Step 2: Commit**

```bash
git add programs/octora-executor/README.md
git commit -m "docs(executor): document DLMM-only mainnet v1 scope"
```

---

## Task 6: Final production checks

**Files:**
- No code changes expected.

- [ ] **Step 1: Run formatting**

```bash
cargo fmt --check -p octora-executor
```

Expected: pass.

- [ ] **Step 2: Run build**

```bash
cargo build -p octora-executor
```

Expected: pass.

- [ ] **Step 3: Run Anchor build**

```bash
anchor build
```

Expected: pass.

- [ ] **Step 4: Run tests**

```bash
anchor test
```

Expected: pass. If DAMM tests exist, disable or move them out of mainnet v1 CI.

- [ ] **Step 5: Record deployment gate**

Do not deploy to mainnet until:

```text
- DLMM lifecycle tested on devnet
- DLMM negative tests pass
- Token-2022 owner validation tested
- upgrade authority strategy decided
- production RPC configured
- dedicated mainnet keypair funded
```

---

## Self-Review

- Spec coverage: DLMM-only public API, DAMM excluded from IDL, DLMM init hardening, tests/docs covered.
- No placeholders: all tasks have exact files and commands.
- Type consistency: uses existing instruction names and file paths.
