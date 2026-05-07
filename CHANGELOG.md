# Changelog

All notable changes to Octora are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Audit-driven changes are tagged with the audit finding ID
(e.g. `[C-1]`, `[H-3]`) so the relationship between the audit report
and the shipped fix is auditable.

## [Unreleased]

### Added

- `[C-1]` `ADMIN_AUTHORITY` constant in `programs/octora-mixer/src/constants.rs`
  and an Anchor `address = ADMIN_AUTHORITY` constraint on `initialize`.
  The placeholder pubkey is fail-closed; mainnet deploy must replace it
  with the real Squads multisig vault PDA.
- `[C-1]` Cargo feature `permissionless-init` to bypass the address
  constraint for devnet/local testing only. Production builds use the
  default feature set.
- `[H-1]` Relayer rejects requests where the proof's bound relayer
  field does not match the relayer's own hot-wallet pubkey.
- `[H-2]` Per-nullifier in-flight map in `RelayerService` serializes
  concurrent submissions for the same nullifier so duplicates
  short-circuit instead of racing on-chain.
- `[H-3]` `RelayerConfig.minFeeLamports` floor enforced in both
  `processWithdrawal` and `validateProof`. Reject below-floor fees
  before any RPC or proof-verification work.
- `[H-4]` Hardened `loadHotWallet`: requires explicit `file:<path>`
  prefix, resolves to absolute path, optional
  `OCTORA_HOT_WALLET_DIR` allowlist, mandatory mode-0600 check.
- `[M-2]` `PausedEvent` emitted on `set_paused`, including
  denomination, paused flag, authority, and timestamp — for
  off-chain monitoring of admin actions.
- `[M-4]` `bigintToBeBytes` overflow guard in
  `octora-api/src/modules/relayer/proof-converter.ts` rejects
  negative values and values >= 2^256.
- Production relayer wiring (`relayer.routes.ts`) opt-in via
  `OCTORA_MIXER_RELAYER_ENABLED=true`. Defaults to disabled so
  serverless deploys don't accidentally pick up a hot-wallet.
- `OnChainNullifierRegistry` is the production-mounted nullifier
  source of truth (in-memory variant kept for tests only).
- Phase-2 trusted-setup ceremony scripts under `scripts/ceremony/`:
  `00-init.sh`, `01-contribute.sh`, `02-finalize.sh`, `03-verify.sh`,
  plus `CEREMONY.md` walkthrough.
- Pool rotation policy: `docs/POOL_ROTATION.md` documents tiered
  denominations + auto-rollover at 80% capacity, with the
  denomination-bumping approach for next-generation PDAs.
- Security regression test suite at `tests/octora-mixer-security.ts`
  covering audit findings (C-1 admin gate, set_paused authority,
  paused→deposit/withdraw rejection, FeeOverflow,
  FeeExceedsDenomination, RecipientMismatch, RelayerMismatch,
  RecipientAliasesPool, PublicInputOutOfRange × 2).
- `SECURITY.md` (vulnerability disclosure policy + threat model
  summary).

### Changed

- `[H-5]` Removed dead `getInsertionSiblings` from
  `relayer/deposit.service.ts`. The function silently corrupted the
  local Merkle tree after each call; it was a leftover from the
  pre-`filled_subtrees` design and had no callers.
- `[H-6]` `recordDeposit` in `relayer/deposit.service.ts` now
  validates that `commitment > 0` and the txSignature is a
  realistic-length string. Indexer-only contract documented.
- `[M-3]` Fixed contradictory comment in
  `octora-mixer/src/verifier/groth16.rs::verify_proof` — the doc
  previously said the negation was done on-chain, but it's actually
  done client-side in `convertProofToBytes`.
- Hot-wallet test fixtures use realistic 88-character base58
  signatures (matching real Solana sig lengths) so the new
  `recordDeposit` guard exercises correctly.

### Security

- Pre-mainnet hardening pass complete for `octora-mixer`. All
  CRITICAL and HIGH findings from the internal audit are addressed.
- `octora-executor` audited against the 6-pattern Solana
  vulnerability scanner; **clean** (no CRITICAL / HIGH / MEDIUM
  findings). Two LOW documentation nits noted but not blocking.

### Pending for mainnet

These items are tracked separately and do not block this changelog
entry, but are required before the mainnet `cargo build-sbf` runs:

- Replace `ADMIN_AUTHORITY` placeholder with the real Squads vault PDA.
- Run the Phase-2 ceremony with at least 3 attested contributors and
  apply the resulting `verification_key.json` to
  `programs/octora-mixer/src/verifier/groth16.rs`.
- Set program upgrade authority on `octora-mixer` and
  `octora-executor` to a multisig (not the deploy keypair) with a
  time lock long enough to allow user withdrawals before any
  controversial upgrade lands.
- Confirm DAMM mainnet program ID in
  `programs/octora-executor/src/constants.rs` against Meteora docs.
- External audit (Trail of Bits / OtterSec / Zellic / Asymmetric).
- Bug bounty (Immunefi or Cantina) sized at 10–15% of expected
  pool TVL.

## [0.1.0] – TBD

Initial mainnet release. Will be tagged once the pending items above
are complete and the external audit signs off.
