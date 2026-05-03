# On-Chain Mixer Program — Build Summary

## Why This Was Built

Octora's privacy flow is: **Main Wallet → Mixer → Relayer → Stealth Wallet → Meteora**

Before this work, every component existed **off-chain only** (inside `octora-api/`):

- ZK circuit (`withdraw.circom`) — generates proofs that you deposited without revealing which deposit is yours
- Poseidon Merkle tree — tracks all deposits in a hash tree
- Relayer service — processes withdrawals on behalf of users so their wallet never touches the chain directly
- Stealth wallet — random ephemeral keypair with zero mathematical link to your main wallet
- Meteora API — reads pool data (but can't actually execute LP positions)

**The problem:** There was no smart contract on Solana to actually **hold SOL** and **verify proofs**. When the relayer tried to call `submitWithdrawalTx()`, it just threw "not yet implemented". No real money could flow through the mixer.

**What was built:** A Solana Anchor program (`octora-mixer`) that serves as the on-chain brain of the mixer — it accepts deposits, holds SOL in a vault, and releases funds to stealth wallets after verifying zero-knowledge proofs.

---

## What Was Built

### Project Structure

```
octora/
├── Anchor.toml                              # Anchor workspace config
├── Cargo.toml                               # Rust workspace root
├── programs/
│   └── octora-mixer/
│       ├── Cargo.toml                       # Dependencies: anchor-lang, ark-bn254, groth16-solana, light-poseidon
│       └── src/
│           ├── lib.rs                       # Program entrypoint — 3 instructions
│           ├── state.rs                     # On-chain account structures
│           ├── constants.rs                 # Tree depth, zero hashes, PDA seeds
│           ├── errors.rs                    # 11 error codes
│           ├── events.rs                    # Deposit/Withdraw events for indexing
│           ├── instructions/
│           │   ├── initialize.rs            # Create a new mixer pool
│           │   ├── deposit.rs               # Deposit SOL + commitment into pool
│           │   └── withdraw.rs              # Withdraw via ZK proof verification
│           └── verifier/
│               └── groth16.rs               # On-chain Groth16 proof verifier
├── scripts/
│   ├── compute-zero-hashes.mjs             # Computes Poseidon zero hashes
│   └── convert-vk-to-rust.mjs             # Converts verification_key.json → Rust constants
├── migrations/deploy.ts
└── tests/                                   # (to be written)
```

### Account Design

#### MixerPool (PDA — also serves as the SOL vault)

This is the main account. It stores the pool configuration and Merkle root history. Because it's a PDA owned by the program, the program can directly debit lamports from it — no separate vault account needed.

| Field | Type | Purpose |
|-------|------|---------|
| `authority` | Pubkey (32 bytes) | Admin who can pause/unpause the pool |
| `denomination` | u64 (8 bytes) | Fixed deposit amount in lamports (e.g., 1 SOL = 1,000,000,000) |
| `next_leaf_index` | u32 (4 bytes) | Which Merkle tree slot the next deposit goes into (max 1,048,576) |
| `current_root_index` | u8 (1 byte) | Pointer into the root history ring buffer |
| `root_history` | [u8; 32] × 30 (960 bytes) | Ring buffer of the 30 most recent Merkle roots |
| `is_paused` | bool (1 byte) | Emergency kill switch |
| `bump` | u8 (1 byte) | PDA bump seed |

**Why a ring buffer of 30 roots?** Between when a user fetches their Merkle path and when the relayer submits the withdrawal, other deposits may have changed the root. Keeping 30 recent roots gives ~6 minutes of validity (at Solana's ~400ms slot time), so withdrawals don't fail due to root staleness.

#### NullifierAccount (PDA — one per withdrawal)

Seeds: `["nullifier", pool_key, nullifier_hash]`

Only contains a `bump` byte (9 bytes total with discriminator). Its **existence** is what matters — if this PDA already exists, the nullifier has been spent. Anchor's `init` constraint rejects duplicate creation atomically, preventing double-spend without any lookup logic.

#### CommitmentAccount (PDA — one per deposit)

Seeds: `["commitment", pool_key, commitment]`

Same pattern as NullifierAccount. Prevents the same commitment from being deposited twice.

### Instructions

#### 1. `initialize(denomination: u64)`

Creates a new MixerPool PDA for a given denomination. Only one pool per denomination can exist (enforced by PDA seeds). Sets the initial Merkle root to the precomputed empty-tree root (Poseidon hash of all zeros through 20 levels).

#### 2. `deposit(commitment: [u8; 32], proof_siblings: [[u8; 32]; 20])`

**What the user does:** Generate a random `secret` and `nullifier` off-chain, compute `commitment = Poseidon(secret, nullifier)`, then call this instruction with the commitment and the current Merkle siblings.

**What the program does:**
1. Checks pool isn't paused and tree isn't full
2. Transfers `denomination` lamports from depositor to pool PDA
3. Creates CommitmentAccount PDA (rejects duplicates)
4. Derives path indices from `next_leaf_index` (binary decomposition tells you left vs right at each level)
5. Hashes upward from zero value using siblings — result must match current root (proves siblings are legit)
6. Hashes upward from commitment using same siblings — this is the new root
7. Pushes new root into ring buffer, advances leaf index
8. Emits `DepositEvent` for off-chain indexing

**Why pass siblings?** Storing the full 20-level Merkle tree on-chain would need ~33MB. Instead, the off-chain service maintains the tree, and the depositor provides the 20 sibling hashes needed to verify and update the root. The program validates them by recomputing the old root.

**Compute cost:** ~350K compute units (20 Poseidon hashes at ~15K each + overhead). Well within Solana's 1.4M limit.

#### 3. `withdraw(proof_data: [u8; 256], public_inputs: [u8; 160])`

**What the relayer does:** After verifying the proof off-chain (fast sanity check), it submits this instruction with the packed proof and public inputs.

**What the program does:**
1. Parses 5 public inputs from 160 bytes: `root` (32), `nullifier_hash` (32), `recipient` (32), `relayer` (32), `fee` (32)
2. Checks pool isn't paused, fee < denomination
3. Scans root history for a matching root — fails with `RootNotFound` if expired
4. Verifies `recipient` and `relayer` account keys match the proof's public inputs — prevents front-running (someone swapping the recipient address)
5. Negates proof_a's y-coordinate (required by the BN254 pairing check)
6. Calls `groth16-solana` verifier with the proof, inputs, and hardcoded verification key — uses Solana's native `alt_bn128_pairing` syscall (~200K compute units)
7. Creates NullifierAccount PDA (atomic double-spend prevention)
8. Transfers `denomination - fee` lamports from pool to recipient (stealth wallet)
9. Transfers `fee` lamports from pool to relayer
10. Emits `WithdrawEvent`

### Constants (Precomputed)

The 20 Poseidon zero hashes were computed using circomlibjs and stored as big-endian byte arrays in `constants.rs`. These are needed for:
- Setting the initial empty-tree root during `initialize`
- Verifying Merkle proofs during `deposit` (the "old leaf" is always zero for a fresh insertion)

The initial empty tree root is:
```
15019797232609675441998260052101280400536945603062888308240081994073687793470
```

### Verification Key

The Groth16 verification key constants in `verifier/groth16.rs` are currently **placeholder zeros**. The program compiles and the verification logic is fully wired, but proof verification will always fail until the real VK is generated from the circuit's trusted setup.

A conversion script (`scripts/convert-vk-to-rust.mjs`) handles the encoding:
- G1 points: 64 bytes big-endian, alpha y-negated for pairing
- G2 points: 128 bytes with reversed coefficient order (x_c1, x_c0, y_c1, y_c0) as required by groth16-solana

---

## What Still Needs to Be Done

### 1. Circuit Compilation + Trusted Setup (BLOCKING)

**Status:** `circom` is not installed. Without it, there's no `verification_key.json`, and the on-chain verifier can't work.

**What this produces:**
- `withdraw.wasm` — the compiled circuit (used by snarkjs to generate proofs)
- `withdraw.zkey` — the proving key (used off-chain to create proofs)
- `verification_key.json` — the verification key (converted to Rust constants for on-chain verification)

### 2. Off-Chain Integration

Connect the existing `octora-api` relayer service to the new smart contract:

| File | Change |
|------|--------|
| New: `relayer/proof-converter.ts` | Convert snarkjs proof JSON to 256-byte packed format + 160-byte public inputs |
| New: `relayer/solana-client.ts` | Anchor program client (connection, provider, IDL) |
| Modify: `relayer/relayer.service.ts` | Replace `submitWithdrawalTx()` placeholder with real Solana transaction: derive PDAs, build withdraw instruction, sign with hot wallet, send+confirm |
| Modify: `relayer/deposit.service.ts` | Add `getInsertionSiblings()` method that returns the 20 Merkle siblings needed for the on-chain deposit instruction |
| Modify: `relayer/nullifier-registry.ts` | Add on-chain PDA existence check as fallback behind in-memory cache |

### 3. Integration Tests

Write Anchor TypeScript tests covering:
- Initialize a pool, verify empty-tree root
- Deposit with valid commitment + siblings
- Reject duplicate commitment
- Full deposit → generate proof → withdraw flow
- Reject double-spend (same nullifier)
- Reject invalid proof
- Reject expired root (not in history)

### 4. Live Meteora Executor (Separate from mixer)

The Meteora data layer works, but the execution layer is mocked. `addLiquidity()`, `claim()`, `withdrawClose()` all return fake signatures. This needs to be replaced with real Meteora DLMM SDK calls so the stealth wallet can actually provide liquidity.

---

## What You Need to Do

### Step 1: Install circom

```bash
git clone https://github.com/iden3/circom.git ~/circom
cd ~/circom
cargo build --release
cargo install --path circom

# Verify installation
circom --version
# Should output: circom compiler 2.x.x
```

### Step 2: Run the trusted setup

```bash
cd /Users/theo/Documents/PROJECT/octora/octora-api
npm install circomlib    # circuit dependency (one-time)
bash src/modules/vault/circuits/setup.sh
```

This takes a few minutes. It will:
1. Compile `withdraw.circom` into R1CS + WASM
2. Run a powers-of-tau ceremony (generates randomness for the proof system)
3. Generate the proving key (`withdraw.zkey`)
4. Export the verification key (`verification_key.json`)
5. Copy artifacts to the circuits directory

### Step 3: Convert verification key and rebuild

```bash
cd /Users/theo/Documents/PROJECT/octora

# Generate Rust constants from the verification key
node scripts/convert-vk-to-rust.mjs \
  octora-api/src/modules/vault/circuits/verification_key.json
```

This will print Rust code. Copy the entire output and replace the placeholder constants in `programs/octora-mixer/src/verifier/groth16.rs` (the `VK_ALPHA`, `VK_BETA`, `VK_GAMMA`, `VK_DELTA`, and `VK_IC` arrays).

Then rebuild:

```bash
anchor build
```

### Step 4: Let me know

Once steps 1-3 are done, tell me — I'll:
1. Paste the VK constants into the verifier
2. Write the full integration test suite
3. Wire the off-chain relayer to the smart contract
4. Test the complete flow: deposit → proof → withdraw on localnet
