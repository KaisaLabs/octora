# On-Chain Privacy & Execution

Two Anchor programs on Solana that provide Octora's on-chain primitives. Production fund-moving flows do not CPI between Mixer and Executor — orchestration happens off-chain in the Backend. Compound Mixer/DLMM entrypoints exist only as fail-closed scaffolding until ADR-0003 under `octora-api/docs/adr/` is superseded.

## Language

### octora-mixer

**Mixer Pool**:
The PDA that holds deposited SOL for one **Denomination** and maintains the **Merkle Tree** of **Commitments**. Seeds: `[b"mixer_pool", denomination.to_le_bytes()]`. Uses `zero_copy(unsafe)` due to Solana's 4KB stack limit.
_Avoid_: Vault, pool account

**Denomination**:
Fixed deposit amount in lamports per Mixer Pool. One Mixer Pool per Denomination tier. MVP: SOL only — non-SOL and Token-2022 are gated v2.

**Commitment**:
The 32-byte hash a depositor submits — appended as the next leaf in the Merkle Tree. Stored as a **Commitment Account** PDA so duplicates are rejected.
_Avoid_: Note, deposit hash

**Commitment Account**:
PDA proving a Commitment has been deposited. Seeds: `[b"commitment", mixer_pool, commitment]`. Existence == deposited.

**Nullifier Hash**:
Withdrawal-time hash that prevents double-spends. Submitted alongside the ZK proof.
_Avoid_: Spend tag

**Nullifier Account**:
PDA proving a Nullifier Hash has been spent. Seeds: `[b"nullifier", mixer_pool, nullifier_hash]`. Existence == spent.

**Merkle Tree**:
Poseidon-hashed binary tree of Commitments, depth `TREE_LEVELS`. The on-chain program recomputes the new root from `filled_subtrees + zero hashes` on every deposit — depositor-supplied roots are never trusted.

**Root History**:
Ring buffer of recently-valid Merkle roots, size `ROOT_HISTORY_SIZE`. A withdrawal proof may reference any root currently in the buffer, not only the latest.

**Anonymity Set**:
Number of unspent Commitments in a Mixer Pool at withdrawal time. Backend enforces `MIN_ANONYMITY_SET = 20` as an off-chain guard before submitting a withdraw.

### octora-executor

**Executor**:
Admin-gated Anchor program that CPIs into Meteora DLMM on behalf of Stealth Wallets. Every state-mutating ix requires the global **Executor Config** PDA to exist and `paused == false`.

**Executor Config**:
Singleton PDA storing the Executor's admin authority and global pause flag. Initialized once by `EXECUTOR_ADMIN_AUTHORITY` on a fresh deploy — must be the very first ix sent to the program.
_Avoid_: Config (unqualified — it would collide with backend config)

**DLMM Position**:
The Meteora-side position account that an Executor CPI creates and a Stealth Wallet owns. Carries an `exit_recipient` for exit/claim routing.
_Avoid_: LP Position, Liquidity Position

**Stealth Wallet**:
A single-use, freshly generated ephemeral keypair with no derivation from the user's main wallet. Owns exactly one DLMM Position. (Full definition lives in the Backend glossary — it is operationally a backend concept; here it appears only as the signer of Executor CPIs.)

## Relationships

- A **Mixer Pool** is one-per-**Denomination**.
- A **Commitment** lives in exactly one **Mixer Pool** and corresponds to at most one **Nullifier Hash** (after withdrawal).
- The **Executor** is independent of the **Mixer** for live fund-moving flows: they share no CPI calls and no shared state. The Backend bridges them via a **Stealth Wallet**. Fail-closed compound scaffolds validate program IDs but return `CompoundCpiUnsupported`.
- A **DLMM Position** is owned by a Stealth Wallet, opened via an Executor CPI; the Executor is *not* the position owner.

## Example dialogue

> **Dev:** "If we redeploy `octora-executor`, do we need to re-initialize the Config?"
> **Domain expert:** "Yes — the Executor Config PDA is per program, so a fresh deploy means the very first ix must be `init_config`, signed by `EXECUTOR_ADMIN_AUTHORITY`. Until that runs, every state-mutating DLMM ix will fail."

## Flagged ambiguities

- "Pool" was used for both **Mixer Pool** (octora-mixer) and Meteora's DLMM pool. Resolved: always qualify (**Mixer Pool** vs **DLMM pool**).
- The Executor program emits no equivalent of "Position" — it's purely a CPI proxy. The DLMM Position itself is a Meteora account.
