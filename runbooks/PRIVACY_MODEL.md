# Octora — Privacy model (P1-55)

**Status:** Authoritative description of what privacy Octora does and does not provide for a private-beta user.
**Last updated:** 2026-05-10.
**Audience:** Beta users deciding whether the privacy guarantees match their threat model, and security reviewers evaluating the project.

This document is the contract between Octora and its users on privacy. It is deliberately conservative — every claim should hold for the audited code in this repo at the listed commit. Anything that's a goal but not yet guaranteed is called out as **future**.

## 1. What Octora is

Octora is a privacy execution layer for Meteora liquidity provision on Solana. The user funds an LP position from one wallet (the "main wallet") and exits to another (the "exit wallet"), without an on-chain link between the two. The link is broken by routing through:

1. A Groth16 ZK mixer (`programs/octora-mixer`) holding fixed-denomination deposits.
2. A relayer that submits the user's withdrawal proof and pays the gas, so the exit wallet starts life with no transaction history of its own.
3. A stealth wallet, deterministically derived from the user's main-wallet signature, that owns the LP position end-to-end (`octora-web/src/lib/stealthVault.ts`).

The result a user sees: deposit from `main`, LP position lives under `stealth`, fees / withdrawal land at `exit`. None of those three pubkeys are linked on chain.

## 2. Threat model

### Adversaries we DO defend against

- **Passive on-chain observers** (chain explorers, indexers, off-chain analytics). They see deposits to the mixer, withdrawals from it, and DLMM CPI activity, but cannot link a specific deposit to a specific withdrawal.
- **A single relayer-key compromise where the relayer's hot wallet is rotated within hours**. The on-chain pause + key rotation runbook (`runbooks/deployment/key-rotation.md`) bounds the window in which the compromised key can deanonymize new withdrawals. Past withdrawals through that key remain anonymous to anyone other than the relayer operator.
- **A compromised main wallet's transaction history alone**. Knowing the main wallet's deposit doesn't reveal which downstream stealth wallet or exit wallet it ended up at. Knowing the exit wallet doesn't reveal which deposit funded it.

### Adversaries we do NOT defend against

- **A relayer operator with full server access** in real time. The relayer sees `(nullifierHash, recipient, fee, root, hot-wallet pubkey)` for every in-flight withdrawal it processes. With those four it can link `recipient` to a withdrawal, which is exactly the link a passive observer cannot make. Operationally the audit (P1-17) requires <24h log retention, but a compromised relayer host nullifies that.
- **Adversaries with compromised user devices**. We cannot defend against a key-logger or a compromised browser extension that captures the wallet's `signMessage` output — the stealth keypair is derived from that signature, so revealing it reveals the stealth wallet.
- **Statistical de-anonymization on a thin anonymity set.** A withdrawal from a pool with three deposits is near-trivially linkable by amount + timing. The anonymity set IS the privacy boundary; see §4.
- **Court-ordered disclosure compelling the relayer or the API operator.** The relayer learns enough to link recipient ↔ withdrawal in real time; subpoena resistance is not a property of the protocol.
- **Cross-chain analysis if the main wallet bridges in funds traceable to a CEX KYC profile.** Octora cannot make the main wallet's external history private.
- **Interaction-pattern analysis across multiple deposits/withdrawals from the same user.** If a single user deposits 1 SOL ten times in a row and withdraws 1 SOL ten times to the same exit wallet, statistical correlation makes the link strong even with a healthy global anonymity set.

### Adversaries explicitly out of scope

- **Quantum-capable adversaries** breaking the BN254 curve. Out of scope.
- **Trusted-setup ceremony compromise** where every contributor in `runbooks/ceremony/PROCEDURE.md` collusively held back entropy. The ceremony procedure is designed so one honest contributor is enough; if every contributor colluded, the trapdoor exists and counterfeit proofs can be minted. The mitigation is the ceremony, not the protocol.

## 3. What "private" means for each pubkey

### Main wallet
- Provides the signature that derives the stealth keypair and signs the deposit tx into the mixer.
- An on-chain observer sees: a `Deposit` instruction call to the mixer pool, paying the fixed denomination.
- An on-chain observer **cannot** see: which commitment in the Merkle tree the deposit produced (the deposit emits a `DepositEvent` with a 32-byte commitment; commitments are unlinkable to subsequent nullifiers without the user's secret).

### Stealth wallet
- Owns the LP position via a `PoolAuthority` PDA (`programs/octora-executor/src/state/pool_authority.rs`).
- An on-chain observer sees: a fresh keypair pubkey appearing as the `stealth` signer on `dlmm_init_position` / `damm_init` instructions, after a relayer-funded SOL transfer.
- An on-chain observer **cannot** trivially link the stealth pubkey to any main-wallet pubkey, **provided** the user does not reuse the stealth wallet for an unrelated transaction (which would create a cross-link).

### Exit wallet
- Receives the withdrawal payout from the mixer (denomination − relayer fee).
- An on-chain observer sees: a `Withdraw` instruction call from the relayer's hot wallet, with the exit wallet as a named account.
- An on-chain observer **cannot** link the exit wallet to a specific commitment in the Merkle tree without breaking Poseidon-Groth16 — the proof reveals only `nullifierHash`, not which leaf was being spent.

### Relayer hot wallet
- Pays gas for withdrawal txs and earns the per-withdrawal fee.
- Public. Its balance, history, and tx volume are visible to everyone. The relayer is a trust boundary, not a privacy boundary.

## 4. Anonymity set

The privacy guarantee is bounded by the size of the anonymity set — the number of deposits sitting in the mixer that *could* have funded any given withdrawal.

### Lower bounds we enforce

- **Single fixed denomination per pool.** A 1.0 SOL deposit can only spend a 1.0 SOL leaf; cross-denomination linkage is impossible because the on-chain `withdraw` instruction rejects it (`programs/octora-mixer/src/instructions/withdraw.rs`).
- **Privacy delay gate.** The relayer (`octora-api/src/modules/relayer/relayer.service.ts`) refuses withdrawals whose Merkle root has been observed for less than `OCTORA_MIXER_PRIVACY_DELAY_MS` (default 13s ≈ 32 slots). This prevents the trivial "deposit, withdraw next slot" attack. Persisted in Postgres (P0-15) so a relayer restart cannot bypass the gate.
- **Beta cohort caps** (`BETA_MAX_*`). Reduce the ceiling on a single user's outsized influence on the anonymity set.

### Practical guidance

| Anonymity set size | Linkability for a single withdrawal |
| --- | --- |
| < 10 | Near-trivial. Statistical analysis on amount + timing pinpoints the deposit. |
| 10–50 | Weak. Practitioners with chain analytics tools can usually recover the link. |
| 50–500 | Moderate. Effective against most non-state adversaries. |
| 500+ | Strong, comparable to Tornado Cash classic at peak. |

The mainnet beta opens with the anonymity set at zero — every beta user is contributing to it. Withdrawing too quickly after the first deposit-wave is statistically self-defeating. The frontend's `BetaWarningBanner` and `StealthExplainerModal` (P1-36, P1-38) surface this trade-off.

### Future: minimum N depositors gate

The audit (P1-18) recommends enforcing a minimum N depositors before the relayer accepts any withdrawal. Not yet implemented; tracked in the runbook.

## 5. Stealth wallet — recovery model

The stealth keypair is derived from the user's `signMessage` output (`octora-web/src/lib/stealthVault.ts`), salted by the pool address and a version tag. Properties:

- **Recoverable on any device.** Same wallet + same message → same keypair.
- **No seed phrase.** The seed *is* the signature; nothing to lose if you don't lose the main wallet.
- **Loses access if the main wallet is lost.** No recovery path. Any rent (~0.002 SOL per `PoolAuthority` PDA) and any un-withdrawn dust is stranded.
- **Bumping `Version` in the derivation message** invalidates every previously-derived stealth wallet. Don't do this lightly.

The `StealthExplainerModal` shows this contract to users on first deposit.

## 6. Relayer trust model

The relayer is a **trust amplifier, not a trust root**. Specifically:

- The relayer **cannot** steal user funds. It can only refuse to process a withdrawal — the on-chain `withdraw` instruction binds the recipient pubkey to the proof's public inputs, so a relayer that submits with a substituted recipient gets rejected.
- The relayer **can** observe `(nullifierHash, recipient, fee, root)` in real time, which is enough to link a recipient to that specific withdrawal.
- The relayer **does** earn a per-withdrawal fee — economic alignment with not deplatforming users.

Operationally:

- Log retention is set to ≤24h with at-rest encryption (P1-17). Compromise of the relayer's logs after 24h reveals nothing past that window.
- Future: support **user-submitted withdrawals** for users who hold gas. This removes the relayer from the privacy boundary entirely for those users, at the cost of revealing the user's gas-paying wallet. Tracked in the runbook (P1-17 long-term).

## 7. What the API operator sees

The API operator (the team running `octora-api`) is also a trust boundary:

- Position state, intent metadata, and beta-access approvals live in Postgres. The API can correlate `walletAddress → positions[]` for any wallet that has signed in.
- The API does NOT see private keys: the stealth keypair never leaves the user's browser, the proving witness is generated client-side, the wallet signature is never sent to the API.
- The API DOES see the public stealth pubkey and the wallet that owns it (because the stealth wallet's pubkey is referenced when querying positions). This is a deliberate trade-off for the beta-access UX.

If the API operator is compromised, an attacker learns the same things the API knows: the (main wallet → position) map. They learn **nothing additional** about the (deposit → withdrawal) link, which is held off-chain only by the relayer.

## 8. What an attacker who fully compromises the API + relayer learns

In the worst case — both API host and relayer host root-compromised by the same actor — the attacker can link:

- main wallet → stealth wallet (via API position records).
- recipient (exit wallet) → withdrawal tx (via relayer logs, within the ≤24h retention window).
- Indirectly: main wallet → exit wallet via the joined view, but only if the same Merkle root window covers both observations.

This is the worst case the audit (`runbooks/PRODUCTION_READINESS.md` P0-21) treats as a threat. The mitigations are operational (KMS-backed signing, mTLS between API and signer, log retention) and architectural (move toward user-submitted withdrawals so the relayer falls out of the trust path for users with gas).

## 8b. Swap-layer privacy (Plan 2/3/4)

The Meteora swap layer added under `docs/plans/meteora-swap-layer/` extends the privacy model along one new edge: when a user LPs into a pool whose quote asset is not SOL (e.g. JUP/USDC), the stealth wallet first executes an on-chain Meteora DLMM swap on a different SOL-paired pool to acquire the target token, then proceeds to `add_liquidity`.

What changes for an on-chain observer:

- **The stealth wallet performs *two* CPI calls instead of one** (`dlmm_swap` then `dlmm_add_liquidity`). The two calls happen in separate transactions with the relayer as fee-payer; their relative timing is observable.
- **The swap source pool is observable.** Anyone watching DLMM swap events on the source pool sees a fresh stealth wallet swapping SOL for token X, immediately followed by an LP position opening on a different X/Y pool. The link `stealth ↔ LP target` was already public before the swap layer; the new fact is `stealth ↔ swap source`.
- **The amounts on the swap leg are observable.** The user's input lamports + slippage min-out + realised output are all in tx logs. This **does not** weaken the `main ↔ stealth` privacy boundary — the swap leg happens after the mixer-fed funding, so the source amount is uncorrelated with any main-wallet activity. It does mean a determined observer can reconstruct the user's *intent* (the target token they wanted) from the swap leg, which they could already do from the LP target pool.

What does NOT change:

- The mixer's role is unchanged. It still breaks `main ↔ stealth` for the SOL leg.
- The relayer's view of the user is unchanged. It pays gas for both swap and LP txs but does not learn anything new — it already knew the stealth pubkey and the target pool.
- The exit wallet's privacy is unchanged. The withdrawal flow is independent of which non-SOL token the LP held.

**Hard rule, enforced at multiple layers:** the swap source pool MUST differ from the LP target pool. Same-pool swap-then-LP front-runs the user's own entry. Reject is in: client-side `SwapPreview`, backend `swap.service.validateSwapIntent`, and the same-pool check in the `position.service` intent path. Phase 2 atomic `swap_then_lp` adds an on-chain enforcement.

**Operator commitments tied to this layer:**
- `EXECUTOR_SWAP_ENABLED` must be off in any deployment whose audit pack (`docs/plans/meteora-swap-layer/audit-pack.md`) has unresolved §10 sign-offs.
- The slippage hard cap (20% / 2000 bps) is mirrored on the API and the UI; bumping it requires a documented cause and a fresh ToS version.
- Per-wallet `BetaAccess.swapEnabled` is the only mechanism for granting individual wallets access during Phase E. No bypass exists at the controller layer; the Plan 4 acceptance criteria block on it.

For the failure modes specific to this layer, see `runbooks/incident/swap-failure.md`.

## 9. Cryptographic foundations

| Primitive | Where used | Source |
| --- | --- | --- |
| Poseidon (BN254) | Merkle tree, commitment, nullifier hash, params binding | circomlib + on-chain `solana-poseidon` |
| Groth16 over BN254 | Withdrawal proof | snarkjs + on-chain `groth16-solana` |
| Ed25519 | Wallet signatures, stealth keypair derivation | Solana standard |
| HKDF-SHA256 | Stealth-seed encryption (P0-16 v3) | `node:crypto` |
| AES-256-GCM | Stealth-seed encryption | `node:crypto` |

The verifying key is generated through the multi-party ceremony documented in `runbooks/ceremony/PROCEDURE.md`. The transcript that pins the trust anchor for mainnet is committed at `runbooks/ceremony/transcript-mainnet-v1/`.

## 10. Residual leaks we know about

These are known limitations called out so users can make an informed choice:

- **Timing correlation across deposits and withdrawals.** Mitigated by the privacy delay gate, but not eliminated. A user who deposits at 14:00 UTC and withdraws at 14:30 UTC gives a passive observer a strong narrowing of which deposit is theirs.
- **Wallet metadata leaks via the wallet provider.** Phantom et al. log RPC calls; Phantom in particular routes a lot of traffic through their own infrastructure. Octora can't prevent that.
- **The user's own behavioral correlation.** Always depositing 1 SOL on Mondays creates a fingerprint regardless of the protocol.
- **Front-end CDN / RPC IP correlation.** Loading `octora.app`, hitting `/positions/intents`, and signing a `withdraw` in close proximity from the same residential IP visibly ties the requests, even if the on-chain footprint is unlinked.

## 11. Versioning

This document is versioned alongside the audited commit. When the privacy model materially changes (new circuit, new relayer architecture, removal of a guarantee), this file is updated in the same PR as the code change. Old versions remain reachable via git history.

The current version corresponds to `chore/mainnet-readiness` as of the trusted-setup ceremony.
