# Octora — Tornado Mixer Architecture (Option A)

> Direct-deposit mixer using Groth16 proofs on Solana devnet. User deposits a fixed amount into the mixer contract, withdraws from a fresh wallet with a ZK proof, then enters a Meteora DLMM pool — fully unlinkable from the original wallet.

---

## Table of Contents

1. [Overview](#overview)
2. [End-to-End Flow](#end-to-end-flow)
3. [Deposit Flow (Detail)](#deposit-flow-detail)
4. [Withdrawal Flow (Detail)](#withdrawal-flow-detail)
5. [Meteora Entry Flow (Detail)](#meteora-entry-flow-detail)
6. [On-Chain Program Design](#on-chain-program-design)
7. [Backend API Design](#backend-api-design)
8. [Database Schema](#database-schema)
9. [Client-Side Responsibilities](#client-side-responsibilities)
10. [Security Considerations](#security-considerations)
11. [Implementation Phases](#implementation-phases)

---

## Overview

The mixer follows the Tornado Cash model adapted for Solana:

- **Fixed denomination deposits** (e.g. 1 SOL) — all deposits look identical on-chain
- **Groth16 zero-knowledge proofs** — prove you deposited without revealing which deposit is yours
- **Relayer-submitted withdrawals** — fresh wallet never needs gas, no on-chain link back
- **Direct Meteora integration** — withdrawn funds flow into DLMM liquidity pools

**Privacy guarantee:** An observer can see that wallet X deposited into the mixer, but cannot determine which withdrawal (or which Meteora position) belongs to wallet X. The anonymity set is every deposit in the pool.

**Trust model:** Non-custodial. The on-chain program holds funds. The backend never has custody — it only relays withdrawal transactions and manages Meteora positions.

---

## End-to-End Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER'S MAIN WALLET                             │
│                                                                        │
│  Holds: 5 SOL                                                          │
│  Wants: Private liquidity position on Meteora SOL-USDC pool            │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                    STEP 1: DEPOSIT
                    (main wallet → mixer)
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      VAULT MIXER CONTRACT                              │
│                                                                        │
│  On-chain Merkle tree of commitments                                   │
│  Pool balance: N × 1 SOL                                               │
│  Observable: "wallet X deposited 1 SOL" (but which withdrawal is X?)   │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                    STEP 2: WITHDRAW
                    (mixer → fresh wallet)
                    (relayer submits tx)
                    (Groth16 proof on-chain)
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        FRESH WALLET                                    │
│                                                                        │
│  Brand new keypair, no history, no link to main wallet                 │
│  Receives: 1 SOL - relayer fee                                         │
│  Observable: "mixer sent SOL to wallet Y" (no link to wallet X)        │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                    STEP 3: ENTER METEORA POOL
                    (fresh wallet → DLMM position)
                    (backend orchestrates tx)
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     METEORA DLMM POOL                                  │
│                                                                        │
│  Fresh wallet opens a liquidity position                               │
│  Backend tracks position lifecycle (claim, rebalance, withdraw)        │
│  Observable: "wallet Y added liquidity" (no link to wallet X)          │
└─────────────────────────────────────────────────────────────────────────┘
```

**What an observer sees on-chain:**

| Step | On-chain data | Can observer link to main wallet? |
|------|--------------|-----------------------------------|
| Deposit | Wallet X → Mixer (1 SOL) + commitment hash | Yes — knows X used the mixer |
| Withdraw | Mixer → Wallet Y (1 SOL - fee) + nullifier hash + ZK proof | No — proof reveals nothing about which deposit |
| Meteora | Wallet Y → DLMM pool (liquidity) | No — Y has no history linking to X |

---

## Deposit Flow (Detail)

### What happens step by step

```
USER (browser/client)                    BACKEND API                     SOLANA (on-chain)
─────────────────────                    ───────────                     ─────────────────
                                                                        
1. User clicks "Deposit 1 SOL"
   │
   ├─ Client generates locally:
   │   secret    = random 31 bytes
   │   nullifier = random 31 bytes
   │   commitment    = Poseidon(secret, nullifier)
   │   nullifierHash = Poseidon(nullifier)
   │
   ├─ Client stores secret + nullifier
   │  in browser (localStorage / file)
   │  ⚠️  This is the "note" — lose it, lose funds
   │
   │
   ▼
2. POST /vault/deposit
   { commitment }              ──────►  Validate commitment format
                                        Return unsigned deposit tx
                               ◄──────  { serializedTx, commitment }
   │
   │
   ▼
3. Client signs tx with
   main wallet (Phantom/Backpack)
   │
   │
   ▼
4. POST /vault/deposit/confirm
   { signedTx }               ──────►  Submit tx to Solana RPC
                                                                    ──► Vault program: deposit()
                                                                        • Accept exactly 1 SOL
                                                                        • Insert commitment into
                                                                          on-chain Merkle tree
                                                                        • Emit DepositEvent {
                                                                            commitment,
                                                                            leafIndex,
                                                                            timestamp
                                                                          }
                                                                    ◄──
                                        Wait for confirmation
                                        Store commitment + leafIndex
                                        in DB (for Merkle tree sync)
                               ◄──────  { txSignature, leafIndex }
   │
   │
   ▼
5. Client shows:
   "Deposit confirmed! Save your note."
   Displays note: { secret, nullifier, commitment }
```

### Deposit rules

- **Fixed denomination only:** 1 SOL per deposit (configurable per pool, e.g. 0.1, 1, 10 SOL)
- **Commitment must be unique:** On-chain program rejects duplicate commitments
- **Secret + nullifier stay client-side:** Backend never sees them. If the user loses them, funds are unrecoverable

---

## Withdrawal Flow (Detail)

### What happens step by step

```
USER (browser/client)                    BACKEND API (relayer)           SOLANA (on-chain)
─────────────────────                    ────────────────────            ─────────────────

1. User generates a fresh wallet
   (new keypair, no SOL, no history)
   │
   │
   ▼
2. User enters their note:
   { secret, nullifier }
   │
   ├─ Client computes:
   │   commitment    = Poseidon(secret, nullifier)
   │   nullifierHash = Poseidon(nullifier)
   │
   │
   ▼
3. GET /vault/merkle-path/{commitment}
                               ──────►  Look up leafIndex for commitment
                                        Compute Merkle proof path
                               ◄──────  { root, pathElements, pathIndices }
   │
   │
   ▼
4. Client generates Groth16 proof
   (snarkjs WASM, runs in browser)
   │
   ├─ Public inputs:
   │   root           = current Merkle root
   │   nullifierHash  = Poseidon(nullifier)
   │   recipient      = fresh wallet address (as bigint)
   │   relayer        = backend relayer address (as bigint)
   │   fee            = relayer fee amount
   │
   ├─ Private inputs:
   │   secret, nullifier
   │   pathElements, pathIndices
   │
   ├─ Output: { proof, publicSignals }
   │
   │
   ▼
5. POST /vault/withdraw
   { proof, publicSignals,
     recipient }               ──────►  Verify proof off-chain (fast check)
                                        Check nullifierHash not spent in DB
                                        Build withdrawal tx
                                        Sign tx with relayer wallet
                                        Submit tx to Solana RPC
                                                                    ──► Vault program: withdraw()
                                                                        • Verify nullifier not in
                                                                          spent set
                                                                        • Verify Groth16 proof
                                                                          (alt_bn128 precompiles)
                                                                        • Verify root matches a
                                                                          recent valid root
                                                                        • Transfer (1 SOL - fee)
                                                                          to recipient
                                                                        • Transfer fee to relayer
                                                                        • Add nullifier to spent set
                                                                        • Emit WithdrawEvent {
                                                                            nullifierHash,
                                                                            recipient,
                                                                            fee
                                                                          }
                                                                    ◄──
                                        Wait for confirmation
                                        Mark nullifier as spent in DB
                               ◄──────  { txSignature }
   │
   │
   ▼
6. Fresh wallet now has:
   1 SOL - relayer fee
   Ready to enter Meteora
```

### Withdrawal rules

- **Nullifier is single-use:** Both on-chain (spent set) and off-chain (DB) enforce this. Double-withdrawal is impossible
- **Relayer pays gas:** Fresh wallet has 0 SOL, so the relayer (backend) signs and pays the tx fee
- **Relayer fee:** Small fee (e.g. 0.005 SOL) deducted from withdrawal amount, sent to relayer address
- **Proof binds recipient + relayer + fee:** Groth16 proof includes these as public inputs, so the relayer can't redirect funds or inflate the fee
- **Root freshness:** On-chain program stores recent N roots (e.g. last 30). Proof must use one of them. This handles deposits that arrive after the user fetched their Merkle path

---

## Meteora Entry Flow (Detail)

### What happens step by step

```
USER (browser/client)                    BACKEND API                     SOLANA (on-chain)
─────────────────────                    ───────────                     ─────────────────

1. User selects pool + strategy
   from fresh wallet context
   │
   │
   ▼
2. POST /positions/intents
   { action: "add-liquidity",
     amount: "0.99",
     pool: "sol-usdc",
     mode: "standard",
     wallet: freshWalletPubkey }
                               ──────►  Create position intent
                                        Build add-liquidity tx:
                                        • Determine bin range (strategy)
                                        • Calculate token distribution
                                        • Build Meteora DLMM IX
                               ◄──────  { positionId, serializedTx }
   │
   │
   ▼
3. Client signs tx with
   FRESH wallet (not main wallet)
   │
   │
   ▼
4. POST /positions/{id}/execute
   { signedTx }               ──────►  Submit tx to Solana RPC
                                                                    ──► Meteora DLMM program:
                                                                        • Create position account
                                                                        • Deposit tokens into bins
                                                                        • Position now earning fees
                                                                    ◄──
                                        Index position on-chain data
                                        Track in DB for lifecycle mgmt
                               ◄──────  { txSignature, position }
   │
   │
   ▼
5. Position is now ACTIVE
   │
   ├─ Claim fees:  POST /positions/{id}/claim     (signed by fresh wallet)
   ├─ Rebalance:   POST /positions/{id}/rebalance  (signed by fresh wallet)
   └─ Close:       POST /positions/{id}/withdraw-close
                                                                    ──► Meteora returns SOL
                                                                    ◄──
                                                                        
   After closing, user can:
   └─ Re-deposit into mixer (new commitment, new anonymity cycle)
   └─ Transfer to another fresh wallet
   └─ Withdraw through mixer again with new secrets
```

### Meteora integration notes

- **Fresh wallet is the position owner:** All Meteora transactions are signed by the fresh wallet. The main wallet never touches the pool
- **Position lifecycle is identical** to existing Octora flow — the only difference is which wallet signs
- **Backend tracks positions by wallet,** not by user identity — the backend doesn't know (or need to know) which main wallet is behind each fresh wallet
- **Fees accumulate in fresh wallet:** When the user claims Meteora fees, they arrive in the fresh wallet. No link to main wallet

---

## On-Chain Program Design

### Accounts

```
VaultState (PDA, singleton per denomination)
├── authority: Pubkey           (program authority)
├── denomination: u64           (fixed deposit amount in lamports)
├── merkle_root: [u8; 32]      (current Merkle root)
├── next_leaf_index: u32        (next available leaf)
├── root_history: [[u8; 32]; 30]  (last 30 valid roots for freshness)
├── root_history_index: u8      (circular buffer pointer)

NullifierAccount (PDA per nullifier hash)
├── spent: bool                 (always true once created)

MerkleLeaf (PDA per leaf index) — optional, for on-chain tree
├── commitment: [u8; 32]
├── leaf_index: u32
```

### Instructions

#### `initialize(denomination: u64)`
- Create VaultState PDA
- Set denomination, zero out Merkle tree
- Admin-only, called once per denomination pool

#### `deposit(commitment: [u8; 32])`
- Require transfer of exactly `denomination` lamports to vault PDA
- Reject if commitment already exists
- Insert commitment at `next_leaf_index`
- Recompute Merkle root (or defer to off-chain indexer with on-chain root update)
- Push new root into `root_history` circular buffer
- Increment `next_leaf_index`
- Emit `DepositEvent { commitment, leaf_index, timestamp }`

#### `withdraw(proof: Groth16Proof, public_inputs: WithdrawPublicInputs)`

Public inputs layout:
```
[0] root           — must match one of root_history entries
[1] nullifierHash  — must not already have a NullifierAccount
[2] recipient      — receives denomination - fee
[3] relayer        — receives fee
[4] fee            — relayer fee amount
```

Steps:
1. Verify `root` exists in `root_history`
2. Verify NullifierAccount PDA does not exist (not spent)
3. Verify Groth16 proof using `sol_alt_bn128` syscalls
4. Create NullifierAccount PDA (marks nullifier as spent)
5. Transfer `denomination - fee` lamports from vault PDA to `recipient`
6. Transfer `fee` lamports from vault PDA to `relayer`
7. Emit `WithdrawEvent { nullifier_hash, recipient, relayer, fee, timestamp }`

### Groth16 on-chain verification

Solana provides `alt_bn128` precompiled syscalls (v1.16+):
- `sol_alt_bn128_group_op` — elliptic curve point operations
- `sol_alt_bn128_pairing` — bilinear pairing check

Reference implementation: `light-protocol/groth16-solana` crate.

The verification fits within Solana's 200K compute unit limit when using precompiles.

---

## Backend API Design

### New endpoints for the vault module

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/vault/deposit` | Build unsigned deposit tx for a given commitment |
| `POST` | `/vault/deposit/confirm` | Submit signed deposit tx, index the commitment |
| `GET` | `/vault/merkle-path/:commitment` | Get Merkle proof path for proof generation |
| `GET` | `/vault/root` | Get current Merkle root |
| `POST` | `/vault/withdraw` | Submit Groth16 proof, relayer executes withdrawal |
| `GET` | `/vault/info` | Pool stats: total deposits, denomination, anonymity set size |

### Request/Response schemas

```typescript
// POST /vault/deposit
interface DepositRequest {
  commitment: string;          // hex-encoded Poseidon hash
}
interface DepositResponse {
  serializedTx: string;        // base64 unsigned transaction
  commitment: string;
  denomination: string;        // "1000000000" (1 SOL in lamports)
}

// POST /vault/deposit/confirm
interface DepositConfirmRequest {
  signedTx: string;            // base64 signed transaction
}
interface DepositConfirmResponse {
  txSignature: string;
  leafIndex: number;
  root: string;                // new Merkle root after insert
}

// GET /vault/merkle-path/:commitment
interface MerklePathResponse {
  root: string;
  pathElements: string[];      // 20 sibling hashes
  pathIndices: number[];       // 20 left/right indicators
  leafIndex: number;
}

// POST /vault/withdraw
interface WithdrawRequest {
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
  };
  publicSignals: string[];     // [root, nullifierHash, recipient, relayer, fee]
  recipient: string;           // Solana pubkey (base58)
}
interface WithdrawResponse {
  txSignature: string;
}

// GET /vault/info
interface VaultInfoResponse {
  denomination: string;        // "1000000000"
  totalDeposits: number;
  anonymitySetSize: number;    // deposits - withdrawals
  currentRoot: string;
}
```

### Backend module structure

```
src/modules/vault/
├── index.ts                    # Public exports
├── vault.routes.ts             # Fastify route registration
├── vault.controller.ts         # HTTP handlers
├── vault.service.ts            # Deposit/withdraw orchestration
├── vault.schema.ts             # Fastify JSON schemas
├── vault.repository.ts         # Prisma data access
├── circuits/                   # ZK artifacts (existing from Phase 1)
│   ├── withdraw.circom
│   ├── withdraw.wasm
│   ├── withdraw.zkey
│   ├── verification_key.json
│   └── setup.sh
├── merkle/                     # Merkle + Poseidon (existing from Phase 1)
│   ├── hasher.ts
│   └── merkle-tree.ts
├── prover/                     # Proof utilities (existing from Phase 1)
│   ├── commitment.ts
│   └── proof-verifier.ts
├── relayer/
│   ├── relayer.service.ts      # Sign + submit withdrawal txs
│   ├── relayer.wallet.ts       # Manage relayer keypair + balance
│   └── fee-calculator.ts       # Compute relayer fee
└── __tests__/
    ├── commitment.test.ts      # (existing from Phase 1)
    ├── proof-verifier.test.ts  # (existing from Phase 1)
    ├── vault.service.test.ts
    └── vault.routes.test.ts
```

---

## Database Schema

```prisma
// ─── Vault Mixer ───

model VaultPool {
  id              String   @id @default(cuid())
  denomination    String                    // "1000000000" (lamports)
  programAddress  String   @unique          // vault program PDA
  currentRoot     String                    // current Merkle root (hex)
  nextLeafIndex   Int      @default(0)
  totalDeposits   Int      @default(0)
  totalWithdrawals Int     @default(0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  commitments     VaultCommitment[]
  nullifiers      SpentNullifier[]
  relayerTxs      RelayerTx[]
}

model VaultCommitment {
  id          String   @id @default(cuid())
  poolId      String
  commitment  String   @unique              // Poseidon(secret, nullifier) hex
  leafIndex   Int                           // position in Merkle tree
  txSignature String                        // deposit tx signature
  depositor   String                        // main wallet pubkey (visible on-chain anyway)
  createdAt   DateTime @default(now())

  pool        VaultPool @relation(fields: [poolId], references: [id])

  @@unique([poolId, leafIndex])
  @@index([commitment])
}

model SpentNullifier {
  id             String   @id @default(cuid())
  poolId         String
  nullifierHash  String   @unique           // Poseidon(nullifier) hex
  recipient      String                     // fresh wallet pubkey
  txSignature    String                     // withdrawal tx signature
  fee            String                     // relayer fee taken (lamports)
  createdAt      DateTime @default(now())

  pool           VaultPool @relation(fields: [poolId], references: [id])

  @@index([nullifierHash])
}

model RelayerTx {
  id            String   @id @default(cuid())
  poolId        String
  type          String                      // "deposit_confirm" | "withdrawal"
  status        String                      // "pending" | "confirmed" | "failed"
  txSignature   String?
  fee           String?                     // relayer fee (for withdrawals)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  pool          VaultPool @relation(fields: [poolId], references: [id])
}
```

---

## Client-Side Responsibilities

The client (browser / octora-web) handles:

### 1. Secret management

```typescript
// Client generates and stores locally — backend NEVER sees these
interface DepositNote {
  secret: string;          // bigint as string
  nullifier: string;       // bigint as string
  commitment: string;      // Poseidon(secret, nullifier) as string
  nullifierHash: string;   // Poseidon(nullifier) as string
  denomination: string;    // "1000000000"
  poolAddress: string;     // vault program address
  depositedAt: string;     // ISO timestamp
}
```

The note is the user's proof of deposit. **If lost, funds are unrecoverable.** The client should:
- Display the note prominently after deposit
- Offer "Download Note" as a JSON file
- Optionally encrypt and store in localStorage

### 2. Fresh wallet generation

```typescript
// Client creates a throwaway keypair
import { Keypair } from "@solana/web3.js";
const freshWallet = Keypair.generate();
// User can import into Phantom/Backpack for Meteora position management
```

### 3. Groth16 proof generation

```typescript
// Client runs snarkjs in the browser (WASM)
import * as snarkjs from "snarkjs";

const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  {
    root,
    nullifierHash,
    recipient: pubkeyToBigInt(freshWallet.publicKey),
    relayer: pubkeyToBigInt(relayerAddress),
    fee: relayerFee.toString(),
    secret: note.secret,
    nullifier: note.nullifier,
    pathElements,
    pathIndices,
  },
  "/circuits/withdraw.wasm",  // served as static asset
  "/circuits/withdraw.zkey",  // served as static asset (~10-50MB)
);
```

Proof generation takes 5-15 seconds in browser depending on device.

---

## Security Considerations

### Must-haves for devnet MVP

| Concern | Mitigation |
|---------|------------|
| Double withdrawal | Nullifier checked both on-chain (PDA existence) and off-chain (DB) |
| Front-running | Proof binds recipient + relayer + fee as public inputs — can't be altered |
| Merkle root staleness | On-chain program stores last 30 roots; proof can use any of them |
| Relayer fee inflation | Fee is a public input in the proof — relayer can't charge more than agreed |
| Note loss | Client-side responsibility; UI must emphasize downloading the note |
| Relayer downtime | Users can submit withdrawal tx themselves if they have gas (non-relayed path) |

### Deferred to mainnet

| Concern | Approach |
|---------|----------|
| Trusted setup | Multi-party ceremony (devnet uses single-contributor) |
| Relayer decentralization | Multiple relayers competing on fee |
| Compliance | Deposit/withdrawal limits, screening, time-locks |
| Note recovery | Viewing key scheme for scanning (like stealth addresses) |

---

## Implementation Phases

| Phase | What | Depends On | Status |
|-------|------|------------|--------|
| **1** | Circom circuit + Poseidon hasher + Merkle tree + proof verifier | — | Done |
| **2** | Anchor program: `deposit()` + `withdraw()` with Groth16 verify | Phase 1 artifacts |  |
| **3** | Backend vault service: deposit/confirm/merkle-path/withdraw endpoints | Phase 1 + 2 |  |
| **4** | Relayer service: wallet management, tx signing, fee logic | Phase 3 |  |
| **5** | Client integration: note management, proof gen (snarkjs WASM), fresh wallet | Phase 3 + 4 |  |
| **6** | Meteora integration: connect fresh wallet flow to existing position lifecycle | Phase 5 |  |
| **7** | Testing on devnet: end-to-end deposit → withdraw → Meteora position | All |  |
