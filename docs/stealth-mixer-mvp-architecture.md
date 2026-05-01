# Octora — Stealth + Mixer MVP Architecture

> Devnet-first privacy layer for Octora. Custom stealth addresses + Groth16 vault mixer built on our existing Fastify backend.

---

## Table of Contents

1. [Overview](#overview)
2. [The Two Core Primitives](#the-two-core-primitives)
3. [Transaction Flow](#transaction-flow)
4. [Backend Module Breakdown](#backend-module-breakdown)
5. [Solana Program (On-Chain)](#solana-program-on-chain)
6. [Prisma Schema Additions](#prisma-schema-additions)
7. [The Circom Circuit (Withdraw Proof)](#the-circom-circuit-withdraw-proof)
8. [Tech Stack](#tech-stack)
9. [Implementation Phases](#implementation-phases)
10. [Integration with Existing Codebase](#integration-with-existing-codebase)

---

## Overview

The MVP delivers two privacy primitives on Solana devnet:

- **Stealth Ephemeral Addresses** — sender deposits SOL/SPL to a one-time address that only the recipient can derive (ECDH-based, no on-chain registry)
- **Vault Mixer** — Tornado Cash-style pool using Groth16 zero-knowledge proofs. Fixed denomination deposits, ZK proof withdrawals break the on-chain link between sender and recipient

The relayer backend (our existing Fastify API) orchestrates both: deriving stealth addresses, tracking Merkle tree state, verifying proofs off-chain, and submitting withdrawal transactions so the recipient never needs to fund their fresh wallet.

---

## The Two Core Primitives

### Stealth Ephemeral Addresses (Deposits)

How it works without Umbra:

1. **Recipient** publishes a **meta-address** — a pair of public keys (viewing pubkey + spending pubkey)
2. **Sender** generates an ephemeral keypair, performs ECDH with the recipient's viewing pubkey to get a shared secret
3. Shared secret is used to derive a **one-time Solana keypair** (the stealth address)
4. Sender deposits funds to that derived address
5. Only the recipient (holding the viewing private key) can scan and discover deposits meant for them
6. Only the recipient (holding the spending private key) can spend from the stealth address

No on-chain registry, no metadata leakage. The only on-chain artifact is a deposit to what looks like a random address.

### Vault Mixer (Withdrawals)

How it works:

1. **Depositor** generates a random `secret` and `nullifier`, computes `commitment = Poseidon(secret, nullifier)`
2. Depositor sends a fixed amount (e.g. 1 SOL) to the vault program with the commitment — it gets inserted into an on-chain Merkle tree
3. **Withdrawer** (same person, different wallet) generates a Groth16 proof that says: *"I know a secret and nullifier whose commitment is in the Merkle tree"* — without revealing which leaf
4. Withdrawer submits the proof + `nullifierHash` to the relayer
5. Relayer verifies the proof, checks nullifier hasn't been spent, submits the withdrawal tx
6. On-chain program verifies the Groth16 proof using Solana's `alt_bn128` precompiles and sends funds to the new wallet

The nullifier hash prevents double-spending. The zero-knowledge proof prevents linking deposit to withdrawal.

---

## Transaction Flow

```
DEPOSIT FLOW:

  User
    │
    ▼
  Relayer API (POST /vault/deposit)
    │
    ├─► Derive stealth address via ECDH
    ├─► User generates commitment = Poseidon(secret, nullifier)
    ├─► Submit deposit tx to vault program (on-chain)
    │     └─► Vault program inserts commitment into Merkle tree
    ├─► Store encrypted note for recipient (off-chain DB)
    └─► Return deposit receipt


WITHDRAWAL FLOW:

  Recipient
    │
    ├─► Scan for deposits (GET /stealth/scan) using viewing key
    ├─► Fetch Merkle proof path (GET /vault/merkle-path/:commitment)
    ├─► Generate Groth16 proof client-side (snarkjs WASM)
    │
    ▼
  Relayer API (POST /vault/withdraw)
    │
    ├─► Verify Groth16 proof off-chain (fast sanity check)
    ├─► Check nullifier not already spent
    ├─► Submit withdrawal tx to vault program (relayer pays gas)
    │     ├─► On-chain Groth16 verification (alt_bn128 precompiles)
    │     ├─► Check nullifier not in spent set
    │     └─► Transfer funds to recipient's fresh wallet
    ├─► Mark nullifier as spent (off-chain DB)
    └─► Return withdrawal receipt
```

---

## Backend Module Breakdown

### Stealth Address Module

```
src/modules/stealth/
├── stealth.routes.ts          # API endpoints
├── stealth.service.ts         # Core stealth address logic
├── crypto/
│   ├── ecdh.ts                # ECDH shared secret derivation
│   ├── stealth-keys.ts        # Spending key + viewing key generation
│   └── derive-address.ts     # Stealth Solana address from shared secret
└── stealth.repository.ts     # Store meta-addresses & encrypted notes (Prisma)
```

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/stealth/meta-address` | Register recipient meta-address (viewing + spending pubkeys) |
| `POST` | `/stealth/derive` | Sender derives a stealth address for a given recipient |
| `GET` | `/stealth/scan` | Recipient scans for incoming deposits using viewing key |

### Vault Mixer Module

```
src/modules/vault/
├── vault.routes.ts             # API endpoints
├── vault.service.ts            # Deposit/withdraw orchestration
├── merkle/
│   ├── merkle-tree.ts          # Sparse Merkle tree (in-memory + DB backed)
│   └── hasher.ts               # Poseidon hash (snarkjs compatible)
├── circuits/                   # Circom compiled artifacts (committed to repo)
│   ├── withdraw.circom         # The ZK circuit source
│   ├── withdraw.wasm           # Compiled WASM witness generator
│   ├── withdraw.zkey           # Proving key (from trusted setup)
│   └── verification_key.json   # Verification key (used on-chain + off-chain)
├── prover/
│   └── proof-verifier.ts       # Off-chain Groth16 verification via snarkjs
├── relayer/
│   ├── relayer.service.ts      # Submit withdrawal txs, manage relayer wallet
│   └── fee-calculator.ts       # Relayer fee logic
└── vault.repository.ts        # Commitments, nullifiers, relayer tx log (Prisma)
```

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/vault/deposit` | Create deposit commitment and submit to vault program |
| `POST` | `/vault/withdraw` | Submit Groth16 proof, relayer executes withdrawal |
| `GET` | `/vault/merkle-path/:commitment` | Get Merkle proof path for a commitment |
| `GET` | `/vault/root` | Get current Merkle root |
| `GET` | `/vault/status` | Pool stats (total deposits, tree size, etc.) |

---

## Solana Program (On-Chain)

Anchor program deployed to devnet. Minimal surface area:

```
programs/vault-mixer/
├── src/
│   └── lib.rs
├── Anchor.toml
└── Cargo.toml
```

**Two instructions:**

### `deposit(commitment: [u8; 32])`

- Accept exactly the fixed denomination (e.g. 1 SOL) from the caller
- Insert `commitment` into the on-chain Merkle tree (next available leaf)
- Emit a `DepositEvent { commitment, leaf_index, timestamp }`

### `withdraw(proof, public_inputs)`

- Verify `nullifier_hash` is not in the spent nullifier set
- Verify Groth16 proof using Solana's `alt_bn128` syscalls (`sol_alt_bn128_group_op`, `sol_alt_bn128_pairing`)
- Verify `root` matches a recent valid Merkle root
- Transfer the fixed denomination to the `recipient` address (minus relayer fee)
- Add `nullifier_hash` to the spent set
- Emit a `WithdrawEvent { nullifier_hash, recipient, relayer, fee, timestamp }`

> **Why alt_bn128?** Solana v1.16+ exposes precompiled syscalls for BN128 curve operations (the curve Groth16 uses). This lets us verify proofs on-chain without deploying a massive custom verifier. Reference: `groth16-solana` crate and Light Protocol's verifier.

---

## Prisma Schema Additions

```prisma
// ─── Stealth Addresses ───

model StealthMetaAddress {
  id              String   @id @default(cuid())
  walletAddress   String   @unique     // owner's main wallet
  viewingPubkey   String               // for scanning incoming deposits
  spendingPubkey  String               // for deriving stealth addresses
  createdAt       DateTime @default(now())
}

model StealthNote {
  id                String   @id @default(cuid())
  ephemeralPubkey   String               // sender's ephemeral pubkey (published)
  encryptedNote     String               // encrypted(secret, amount, token)
  stealthAddress    String               // the derived one-time address
  txSignature       String?              // on-chain deposit tx
  claimed           Boolean  @default(false)
  createdAt         DateTime @default(now())

  @@index([stealthAddress])
}

// ─── Vault Mixer ───

model VaultCommitment {
  id          String   @id @default(cuid())
  commitment  String   @unique         // Poseidon(secret, nullifier)
  leafIndex   Int      @unique         // position in Merkle tree
  amount      String                   // fixed denomination (e.g. "1000000000" lamports = 1 SOL)
  txSignature String                   // deposit tx signature
  createdAt   DateTime @default(now())
}

model SpentNullifier {
  nullifierHash String   @id           // Poseidon(nullifier) — prevents double-withdraw
  txSignature   String                 // withdrawal tx signature
  createdAt     DateTime @default(now())
}

// ─── Relayer ───

model RelayerTx {
  id            String   @id @default(cuid())
  type          String                  // "deposit" | "withdrawal"
  status        String                  // "pending" | "confirmed" | "failed"
  txSignature   String?
  fee           String                  // relayer fee taken (lamports)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}
```

---

## The Circom Circuit (Withdraw Proof)

The circuit proves: *"I know a `secret` and `nullifier` such that `Poseidon(secret, nullifier)` is a leaf in the Merkle tree with the given root, and I'm revealing `Poseidon(nullifier)` for the first time"* — without revealing which leaf, the secret, or the nullifier.

```circom
pragma circom 2.0.0;

include "poseidon.circom";
include "merkletree.circom";

template Withdraw(levels) {
    // ── Public inputs (visible on-chain) ──
    signal input root;             // current Merkle root
    signal input nullifierHash;    // revealed to prevent double-spend
    signal input recipient;        // withdrawal destination address
    signal input relayer;          // relayer address (receives fee)
    signal input fee;              // relayer fee amount

    // ── Private inputs (known only to prover) ──
    signal input secret;
    signal input nullifier;
    signal input pathElements[levels];   // Merkle proof siblings
    signal input pathIndices[levels];    // left/right path indicators

    // 1. Compute commitment = Poseidon(secret, nullifier)
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== secret;
    commitmentHasher.inputs[1] <== nullifier;

    // 2. Verify nullifierHash = Poseidon(nullifier)
    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHash === nullifierHasher.out;

    // 3. Verify commitment exists in the Merkle tree
    component tree = MerkleTreeChecker(levels);
    tree.leaf <== commitmentHasher.out;
    tree.root <== root;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    // 4. Constrain recipient & fee to prevent front-running / tx tampering
    signal recipientSquare;
    recipientSquare <== recipient * recipient;
    signal feeSquare;
    feeSquare <== fee * fee;
}

// 20 levels = 2^20 = ~1,048,576 possible deposits (plenty for devnet MVP)
component main {public [root, nullifierHash, recipient, relayer, fee]} = Withdraw(20);
```

### Trusted Setup (for devnet MVP)

For devnet, a simple trusted setup is fine:

```bash
# 1. Compile the circuit
circom withdraw.circom --r1cs --wasm --sym

# 2. Start ceremony (powers of tau)
snarkjs powersoftau new bn128 15 pot15_0.ptau
snarkjs powersoftau contribute pot15_0.ptau pot15_1.ptau --name="octora-dev"
snarkjs powersoftau prepare phase2 pot15_1.ptau pot15_final.ptau

# 3. Generate proving/verification keys
snarkjs groth16 setup withdraw.r1cs pot15_final.ptau withdraw_0.zkey
snarkjs zkey contribute withdraw_0.zkey withdraw.zkey --name="octora-dev"
snarkjs zkey export verificationkey withdraw.zkey verification_key.json
```

> For mainnet, use a proper multi-party ceremony. For devnet MVP, single-contributor is fine.

---

## Tech Stack

| Component | Library / Tool | Purpose |
|-----------|---------------|---------|
| **ZK Circuit** | Circom 2.0 | Define the withdraw proof circuit |
| **Proof generation** (client-side) | snarkjs (WASM) | Generate Groth16 proofs in browser or Node.js |
| **Off-chain verification** | snarkjs `groth16.verify()` | Sanity check proofs in Fastify before submitting tx |
| **On-chain verification** | `groth16-solana` crate / raw `alt_bn128` syscalls | Verify proofs inside the Solana program |
| **Poseidon hash** (JS) | `circomlibjs` | Hash commitments and nullifiers in the backend |
| **Poseidon hash** (Rust) | `light-poseidon` crate | Hash inside the Solana program |
| **Merkle tree** (JS) | `fixed-merkle-tree` | Track tree state off-chain, generate proof paths |
| **Stealth crypto** | `@noble/curves` (ed25519 ECDH) | Derive stealth addresses |
| **Solana program** | Anchor framework | On-chain vault mixer program |
| **Backend** | Fastify + TypeScript (existing) | Relayer API |
| **Database** | PostgreSQL + Prisma (existing) | Commitments, nullifiers, notes |

---

## Implementation Phases

| Phase | What | Deliverable | Why This Order |
|-------|------|-------------|----------------|
| **1** | Circom circuit + trusted setup + snarkjs proof generation | Working proof gen/verify in Node.js | Everything depends on the circuit working first |
| **2** | Anchor program (`deposit` + `withdraw` with Groth16 verify) | Deployed to devnet | On-chain foundation — can test deposits/withdrawals manually |
| **3** | Merkle tree service in Fastify backend | `src/modules/vault/merkle/` | Backend needs to track commitments and serve proof paths |
| **4** | Relayer service | `src/modules/vault/relayer/` | Submit withdrawal txs on behalf of users, manage relayer wallet + fees |
| **5** | Stealth address module | `src/modules/stealth/` | ECDH derivation, note encryption, scanning endpoint |
| **6** | Wire into existing `PrivacyAdapter` | Replace `MockPrivacyAdapter` | Integrate with the existing position execution flow |

---

## Integration with Existing Codebase

The current codebase already has a `PrivacyAdapter` interface (`src/modules/execution/adapters/`) with a `MockPrivacyAdapter` for development. The vault mixer replaces this with a real implementation:

```typescript
class VaultMixerAdapter implements PrivacyAdapter {
  capabilities() {
    return {
      adapter: "vault-mixer",
      live: true,
      mvpReady: true,
      deterministicReceipts: false, // real proofs, non-deterministic
    };
  }

  async prepareFunding(input: PrepareFundingInput): Promise<PrivacyReceipt> {
    // 1. Derive stealth address for the recipient (ECDH)
    // 2. Generate commitment = Poseidon(secret, nullifier)
    // 3. Submit deposit tx to vault program on-chain
    // 4. Insert commitment into Merkle tree (DB + in-memory)
    // 5. Store encrypted note for recipient
    // 6. Return receipt with deposit details
  }

  async prepareExit(input: PrepareExitInput): Promise<PrivacyReceipt> {
    // 1. Receive Groth16 proof from client (or generate server-side)
    // 2. Verify proof off-chain via snarkjs (fast sanity check)
    // 3. Submit withdrawal tx to vault program via relayer
    // 4. On-chain: Groth16 verification + nullifier check + fund transfer
    // 5. Mark nullifier as spent in DB
    // 6. Return receipt with withdrawal details
  }
}
```

The execution state machine (`draft → awaiting_signature → funding_in_progress → executing → indexing → active → completed`) already handles the full lifecycle — the real crypto just gets wired into the adapter layer. No changes needed to the state machine, routes, or position management.
