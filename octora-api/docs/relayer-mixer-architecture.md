# Relayer + Mixer Architecture

## Overview

Octora's privacy layer ensures the user's main wallet never directly interacts with Meteora LP positions. The system breaks the on-chain link between the user's identity and their LP activity using a **self-hosted relayer** and a **Tornado-style mixer**.

No third-party services (MagicBlock, Light Protocol, etc.) — fully self-hosted infrastructure.

---

## Components

### 1. Mixer (Vault)

A fixed-denomination deposit pool using ZK proofs (Groth16 + Poseidon Merkle tree).

**Location:** `src/modules/vault/`

| File | Role |
|------|------|
| `merkle/hasher.ts` | Poseidon hash function (BN128 field) |
| `merkle/merkle-tree.ts` | 20-level Merkle tree (~1M deposit slots) |
| `prover/commitment.ts` | Generate deposit commitments + withdrawal proof inputs |
| `prover/proof-verifier.ts` | Groth16 proof generation + off-chain verification |
| `circuits/withdraw.circom` | ZK circuit (proves knowledge of deposit without revealing which one) |

**What it does:**
- Accepts fixed-amount deposits (e.g. 1 SOL, 10 SOL per pool)
- Stores commitments in a Merkle tree
- Generates ZK withdrawal proofs that prove "I deposited" without revealing "which deposit is mine"

---

### 2. Relayer

A backend service that submits withdrawal transactions on behalf of users, so their main wallet never appears in withdrawal tx signatures.

**Location:** `src/modules/relayer/`

| File | Role |
|------|------|
| `relayer.service.ts` | Core engine: verify proof → check nullifier → submit tx → mark spent |
| `deposit.service.ts` | Manages deposit-side: commitments, Merkle tree state |
| `nullifier-registry.ts` | Tracks spent nullifiers (prevents double-withdrawal) |
| `stealth-wallet.ts` | Generates + encrypts ephemeral wallets |
| `types.ts` | All type definitions |

**What it does:**
- Receives ZK withdrawal proofs from users
- Verifies proofs off-chain (fast check before spending gas)
- Submits the on-chain withdrawal tx using its own hot wallet (pays gas)
- Deducts a small fee from the withdrawal amount
- Marks nullifiers as spent to prevent double-withdrawals

---

### 3. Stealth Wallet

A fresh ephemeral keypair with **zero mathematical link** to the user's main wallet.

**Location:** `src/modules/relayer/stealth-wallet.ts`

**What it does:**
- Generates random 32-byte seed → Solana Keypair
- Encrypts the seed using a key derived from the user's wallet signature (AES-256-GCM)
- Decrypts + recovers when user signs the same message again

---

### 4. Privacy Adapter

Bridges the relayer into the execution pipeline (implements the `PrivacyAdapter` interface).

**Location:** `src/modules/execution/adapters/relayer.adapter.ts`

**What it does:**
- `prepareFunding()` → generates stealth wallet, returns receipt
- `prepareExit()` → prepares reverse route through mixer

---

## Full Privacy Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER'S BROWSER                               │
└─────────────────────────────────────────────────────────────────────┘
         │                                           │
         │ 1. Deposit SOL into mixer                 │ 6. Sign message
         │    (main wallet signs tx)                 │    to encrypt seed
         │                                           │
         ▼                                           ▼
┌─────────────────┐                        ┌─────────────────┐
│  MIXER PROGRAM  │                        │  STEALTH WALLET │
│  (on-chain)     │                        │  (client-side)  │
│                 │                        │                 │
│  Stores:        │                        │  Random keypair │
│  - commitment   │                        │  No link to     │
│    in Merkle    │                        │  main wallet    │
│    tree         │                        │                 │
└─────────────────┘                        └────────┬────────┘
         │                                          │
         │ 2. Wait (anonymity set grows)            │ 3. Generate ZK proof
         │                                          │    recipient = stealth pubkey
         │                                          │
         ▼                                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           RELAYER SERVICE                             │
│                                                                       │
│  4. Verify ZK proof off-chain (fast)                                 │
│  5. Check nullifier not spent (double-spend prevention)              │
│  6. Submit on-chain withdrawal tx (hot wallet pays gas)              │
│  7. Mark nullifier as spent                                          │
│                                                                       │
│  Hot wallet signs tx → stealth wallet receives (denomination - fee)  │
└─────────────────────────────────────────────────────────────────────┘
         │
         │ 7. Stealth wallet now has SOL
         │
         ▼
┌─────────────────┐
│  METEORA DLMM   │
│                 │
│  Stealth wallet │
│  adds liquidity │
│  (no link to    │
│   main wallet)  │
└─────────────────┘
```

---

## Step-by-Step Breakdown

### Phase 1: Deposit (breaks the link)

1. User connects main wallet (e.g. `5abc...`)
2. Client generates a **commitment**: `commitment = Poseidon(secret, nullifier)`
3. User sends deposit tx to mixer program: `deposit(commitment, amount)`
4. Mixer program stores commitment in on-chain Merkle tree
5. User saves `secret` + `nullifier` locally (needed for withdrawal proof)

### Phase 2: Wait

6. Time passes — other users deposit into the same pool
7. The anonymity set grows (more commitments in the tree = harder to link)

### Phase 3: Generate Stealth Wallet

8. Client generates a fresh random keypair: `generateStealthWallet()`
9. The stealth wallet public key becomes the **recipient** in the withdrawal proof
10. Client encrypts the stealth seed using `wallet.signMessage("octora-vault-key")`
11. Encrypted blob stored (backend or localStorage)

### Phase 4: Withdraw via Relayer

12. Client builds ZK proof inputs:
    - `root` = current Merkle root
    - `nullifierHash` = Poseidon(nullifier)
    - `recipient` = stealth wallet public key
    - `relayer` = relayer hot wallet address
    - `fee` = relayer fee in lamports
    - `secret`, `nullifier`, `pathElements`, `pathIndices` (private inputs)
13. Client generates Groth16 proof (off-chain, in browser or backend)
14. Client submits proof to relayer endpoint: `POST /relayer/withdraw`
15. Relayer verifies proof, checks nullifier, submits on-chain tx
16. Stealth wallet receives `(denomination - fee)` SOL

### Phase 5: LP on Meteora

17. Stealth wallet keypair signs LP transactions on Meteora
18. Position is active — earning fees — with zero on-chain link to main wallet

### Phase 6: Exit (reverse flow)

19. Stealth wallet withdraws LP + closes position
20. Funds route back through mixer → eventually to user's chosen exit address
21. Same ZK proof mechanism in reverse

---

## Security Properties

| Property | How it's achieved |
|----------|-------------------|
| **Unlinkable deposits** | Mixer pools all deposits under the same commitment scheme |
| **Unlinkable withdrawals** | ZK proof reveals nothing about which deposit is being withdrawn |
| **No wallet exposure** | Relayer hot wallet submits all txs — user's main wallet never touches Meteora |
| **No mathematical link** | Stealth wallet is pure random — not derived from main wallet |
| **Double-spend prevention** | Nullifier hash is unique per deposit; registry rejects duplicates |
| **Recoverable** | User signs a message → decryption key → stealth seed recovered |
| **Self-hosted** | No third-party relayer dependency — full control |

---

## What's Built vs. What's Next

### Built (off-chain infrastructure)

- [x] Merkle tree (Poseidon, 20 levels, ~1M slots)
- [x] Commitment generation (secret + nullifier → commitment hash)
- [x] Groth16 proof generation + off-chain verification
- [x] Relayer service (proof verification, nullifier checks, tx submission interface)
- [x] Deposit service (tree management, commitment tracking)
- [x] Nullifier registry (in-memory for MVP)
- [x] Stealth wallet generation + AES-256-GCM encryption/decryption
- [x] Privacy adapter (plugs into execution pipeline)
- [x] Circom circuit for withdrawal proofs

### Next (on-chain program)

- [ ] Anchor program: `deposit` instruction (stores commitment in on-chain Merkle tree)
- [ ] Anchor program: `withdraw` instruction (verifies Groth16 proof on-chain, transfers SOL)
- [ ] On-chain nullifier account (PDA per nullifier hash)
- [ ] On-chain Merkle tree account (or root history for gas optimization)
- [ ] Relayer `submitWithdrawalTx` wired to actual Solana transaction construction
- [ ] Multiple denomination pools (1 SOL, 5 SOL, 10 SOL)
