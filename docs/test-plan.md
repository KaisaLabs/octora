# Octora — Test Plan (single source of truth)

This document is the canonical catalogue of test cases for Octora. Every unit test, integration test, end-to-end test, and manual test must trace back to a `TC-*` ID listed here. New cases get a new ID; obsolete cases are kept and marked `DEPRECATED` so prior test runs remain interpretable.

**Legend**

- **Type**: `+` positive (happy path) · `-` negative (must reject) · `~` edge (boundary / non-obvious)
- **Layers**: `U` unit · `I` integration · `E` e2e · `M` manual. A case may target several. Pick the cheapest layer that proves the invariant; add higher layers only when the cheaper one cannot.
- **IDs**: `MIX-*` mixer program · `EXE-*` executor program · `API-MIX-*` mixer API · `API-RLY-*` relayer API · `API-POS-*` positions API · `API-EXE-*` executor tx-build API · `API-DLM-*` DLMM API · `API-MISC-*` health/prices/waitlist · `FE-*` frontend · `E2E-*` cross-component · `OPS-*` cross-cutting (rate limit, persistence, observability, recovery).

---

## 1. Mixer program (`octora-mixer`)

### 1.1 `initialize`

| ID | Type | Layers | Case |
|---|---|---|---|
| MIX-INIT-001 | + | U,I | Initialize new pool with valid denomination → MixerPool PDA created with empty-tree root, paused=false, root history filled with zero root, leaf_index=0. |
| MIX-INIT-002 | - | U | Initialize with `denomination = 0` → fails `InvalidDenomination`. |
| MIX-INIT-003 | - | I | Initialize twice with same denomination from same authority → second tx fails (PDA already in use). |
| MIX-INIT-004 | ~ | U | Initialize with `denomination = u64::MAX` → succeeds; later deposits never trigger fee overflow because fee bound checks denomination. |
| MIX-INIT-005 | + | U | Pool authority is set to signer; `set_paused` callable only by authority. |

### 1.2 `deposit`

| ID | Type | Layers | Case |
|---|---|---|---|
| MIX-DEP-001 | + | U,I | Deposit exactly `denomination` lamports with fresh commitment → MixerPool lamports increase by denomination, commitment leaf inserted, leaf_index increments, root history advanced, `DepositEvent` emitted with correct (commitment, leaf_index, new_root). |
| MIX-DEP-002 | - | U,I | Deposit when `paused=true` → `PoolPaused`. |
| MIX-DEP-003 | - | U,I | Deposit with commitment already used (CommitmentAccount PDA exists) → fails on Anchor `init` constraint. |
| MIX-DEP-004 | - | U | Deposit value < denomination → fails (lamport-transfer guard). |
| MIX-DEP-005 | - | U | Deposit value > denomination → fails (only exact denomination allowed). |
| MIX-DEP-006 | - | U | Deposit with commitment that is not a canonical BN254 field element (≥ r) → `PublicInputOutOfRange`. |
| MIX-DEP-007 | ~ | U,I | Deposit at `leaf_index = 2^20 - 1` (last leaf) → succeeds, then next deposit fails `TreeFull`. |
| MIX-DEP-008 | ~ | U | After deposit, all 30 entries of root history remain valid until 30 further deposits push the original root out. |
| MIX-DEP-009 | ~ | U | Two deposits in the same slot produce distinct roots (sequential leaf indices). |
| MIX-DEP-010 | + | I | DepositEvent log can be parsed back into `(commitment, leaf_index, new_root)` by the API indexer. |

### 1.3 `withdraw`

| ID | Type | Layers | Case |
|---|---|---|---|
| MIX-WDR-001 | + | U,I | Withdraw with valid Groth16 proof, fresh nullifier, current root, recipient ≠ pool, fee < denomination → recipient receives `denomination - fee`, relayer receives `fee`, NullifierAccount PDA created, `WithdrawEvent` emitted. |
| MIX-WDR-002 | - | U,I | Replay same proof → fails (NullifierAccount already exists). |
| MIX-WDR-003 | - | U,I | Withdraw with proof for a root no longer in the 30-entry ring buffer → `RootNotFound`. |
| MIX-WDR-004 | - | U | Withdraw with malformed proof bytes (256 bytes but invalid curve points) → `InvalidProof`. |
| MIX-WDR-005 | - | U | Withdraw with valid proof but recipient passed in accounts ≠ recipient encoded in public inputs → `RecipientMismatch`. |
| MIX-WDR-006 | - | U | Withdraw with relayer in accounts ≠ relayer in public inputs → `RelayerMismatch`. |
| MIX-WDR-007 | - | U | Withdraw with `fee >= denomination` in public inputs → `FeeExceedsDenomination`. |
| MIX-WDR-008 | - | U | Withdraw with fee public input where upper 24 bytes are non-zero (does not fit in u64) → `FeeOverflow`. |
| MIX-WDR-009 | - | U | Withdraw when pool lamports < denomination → `InsufficientPoolBalance` (cannot happen in normal flow; force via test). |
| MIX-WDR-010 | - | U | Withdraw with `recipient == MixerPool PDA` → `RecipientAliasesPool`. |
| MIX-WDR-011 | - | U | Withdraw with nullifier hash ≥ BN254 field modulus → `PublicInputOutOfRange`. |
| MIX-WDR-012 | - | U,I | Withdraw with `paused=true` → `PoolPaused`. |
| MIX-WDR-013 | + | U,I | Withdraw with `fee = 0` → relayer receives nothing, recipient receives full denomination. |
| MIX-WDR-014 | ~ | U,I | Withdraw with `fee = denomination - 1` → recipient receives 1 lamport, relayer receives denomination-1. |
| MIX-WDR-015 | ~ | I | Two users deposit; user A withdraws with proof against state-after-B; succeeds without invalidating B's commitment (multi-user anonymity, mirrors `octora-coverage-gaps.ts` Gap 3). |
| MIX-WDR-016 | ~ | I | Withdrawal proof generated against root R; one more deposit happens; old proof still valid because R is still inside the 30-root ring → succeeds. |
| MIX-WDR-017 | ~ | I | Withdrawal proof generated against root R; 31 deposits happen → proof now fails `RootNotFound`. |

### 1.4 `set_paused`

| ID | Type | Layers | Case |
|---|---|---|---|
| MIX-PAUSE-001 | + | U | Authority pauses pool → flag flips, deposit/withdraw revert with `PoolPaused`. |
| MIX-PAUSE-002 | + | U | Authority unpauses pool → deposits and withdrawals resume. |
| MIX-PAUSE-003 | - | U | Non-authority signer calls `set_paused` → `Unauthorized`. |
| MIX-PAUSE-004 | ~ | U | Pause is idempotent (calling with same flag is a no-op, not an error). |

### 1.5 Cryptographic invariants

| ID | Type | Layers | Case |
|---|---|---|---|
| MIX-CRYPTO-001 | + | U | Poseidon hash of fixed test vector matches reference (circomlib) implementation. |
| MIX-CRYPTO-002 | + | U | Empty Merkle tree of depth 20 has the published canonical zero-root. |
| MIX-CRYPTO-003 | + | U | Inserting a known commitment at index 0 with known siblings reproduces the expected new root (compare on-chain math vs. JS Merkle lib). |
| MIX-CRYPTO-004 | ~ | U | Leaf at index 0 (left-most) and leaf at index 2^20-1 (right-most) both verify with their respective sibling paths. |
| MIX-CRYPTO-005 | - | U | Merkle proof with sibling array length ≠ 20 → `InvalidMerkleProof`. |
| MIX-CRYPTO-006 | - | U | Merkle proof with siblings provided in wrong endianness → root mismatch → `InvalidMerkleProof`. |
| MIX-CRYPTO-007 | - | U | Field element exactly equal to BN254 modulus → `PublicInputOutOfRange`. |
| MIX-CRYPTO-008 | + | U | `Poseidon(secret, nullifier) == commitment` reproducible across client and server. |

---

## 2. Executor program (`octora-executor`)

### 2.1 DLMM `init_position`

| ID | Type | Layers | Case |
|---|---|---|---|
| EXE-DLM-INIT-001 | + | U,I | Init with valid stealth signer, valid lb_pair, lower_bin_id in range, width ≥ 1, exit_recipient = SOL system account → PoolAuthority PDA created with stored stealth_pubkey and exit_recipient. |
| EXE-DLM-INIT-002 | - | U,I | Init with stealth signer that does not sign → `MissingRequiredSignature`. |
| EXE-DLM-INIT-003 | - | U | Init with `width = 0` → `InvalidArgument`. |
| EXE-DLM-INIT-004 | - | U | Init with width that crosses more than 2 bin arrays → rejected. |
| EXE-DLM-INIT-005 | - | U | Init with DLMM program account whose pubkey ≠ configured DLMM program ID → `ProgramMismatch`. |
| EXE-DLM-INIT-006 | ~ | U,I | Re-init with identical (stealth, lb_pair) → second tx fails because PoolAuthority PDA already exists; API surface treats as idempotent and skips re-issue (mirrors Gap 2). |
| EXE-DLM-INIT-007 | ~ | I | Init range that fits in a single bin array (e.g. `[-5, -1]`) → API width-adjuster expands to span two arrays so add-liquidity does not hit `AccountBorrowFailed` (mirrors Gap 1). |
| EXE-DLM-INIT-008 | ~ | U,I | Init with active bin exactly at boundary of two bin arrays → width adjustment direction picks the correct neighbour. |
| EXE-DLM-INIT-009 | - | U | Init with exit_recipient set to PoolAuthority PDA itself → rejected (would loop funds). |

### 2.2 DLMM `add_liquidity`

| ID | Type | Layers | Case |
|---|---|---|---|
| EXE-DLM-ADD-001 | + | U,I,E | Add liquidity with stealth signer matching PoolAuthority.stealth_pubkey, valid liquidity_params, balanced bin arrays → DLMM CPI succeeds, position state advances, lamports debited from stealth. |
| EXE-DLM-ADD-002 | - | U | Add with signer ≠ stealth_pubkey on PoolAuthority → `Unauthorized`. |
| EXE-DLM-ADD-003 | - | U | Add against a different lb_pair than the one stored on PoolAuthority → `AccountMismatch`. |
| EXE-DLM-ADD-004 | - | U | Add with empty `liquidity_params` Vec<u8> → `InvalidArgument`. |
| EXE-DLM-ADD-005 | - | U | Add with bin arrays not adjacent / not those derived from stored bin range → CPI fails. |
| EXE-DLM-ADD-006 | - | I | Add when stealth has insufficient SOL → CPI returns insufficient funds, position transitions to failed with stage `funding`. |
| EXE-DLM-ADD-007 | ~ | I | Add single-sided SOL into a SOL-quote pool → succeeds with one side zero. |
| EXE-DLM-ADD-008 | ~ | I | Add immediately after init within same block → succeeds (no race on PoolAuthority creation). |
| EXE-DLM-ADD-009 | - | U | Add with token program account that is neither SPL-Token nor Token-2022 → rejected. |

### 2.3 DLMM `claim_fees`

| ID | Type | Layers | Case |
|---|---|---|---|
| EXE-DLM-CLM-001 | + | U,I | Claim with accrued fees → fees transferred to exit_recipient on PoolAuthority. |
| EXE-DLM-CLM-002 | + | U,I | Claim when no fees accrued → tx succeeds, zero lamports moved (no-op). |
| EXE-DLM-CLM-003 | - | U | Claim with signer ≠ stealth → `Unauthorized`. |
| EXE-DLM-CLM-004 | - | U | Claim with destination token account whose owner ≠ stored exit_recipient → `AccountMismatch`. |
| EXE-DLM-CLM-005 | ~ | I | Two consecutive claims back-to-back → second is a no-op, no double-payout. |

### 2.4 DLMM `withdraw_close`

| ID | Type | Layers | Case |
|---|---|---|---|
| EXE-DLM-WC-001 | + | U,I | Withdraw with `bps_to_remove = 10_000` (100%) and full bin range → position closed, lamports returned to exit_recipient. |
| EXE-DLM-WC-002 | + | U,I | Partial withdraw with `bps_to_remove = 5_000` → 50% liquidity removed, position remains open. |
| EXE-DLM-WC-003 | - | U | `bps_to_remove = 0` → rejected as no-op (or accepted as no-op — pin behaviour explicitly via this case). |
| EXE-DLM-WC-004 | - | U | `bps_to_remove > 10_000` → `InvalidArgument`. |
| EXE-DLM-WC-005 | - | U | `from_bin_id > to_bin_id` → `InvalidArgument`. |
| EXE-DLM-WC-006 | - | U | Withdraw range outside the position's stored bin range → CPI failure. |
| EXE-DLM-WC-007 | - | U | Signer ≠ stealth → `Unauthorized`. |
| EXE-DLM-WC-008 | ~ | I | Withdraw 100% then call again → second call fails because position account is closed. |

### 2.5 DAMM instructions

| ID | Type | Layers | Case |
|---|---|---|---|
| EXE-DAM-INIT-001 | + | U,I | DAMM init with valid stealth + exit_recipient → PoolAuthority created. |
| EXE-DAM-DEP-001 | + | U,I | DAMM deposit with `pool_token_amount > 0` and `max_sol` covering required SOL → succeeds. |
| EXE-DAM-DEP-002 | - | U | Deposit when SOL cost exceeds `max_sol` → CPI fails with slippage error. |
| EXE-DAM-DEP-003 | - | U | Deposit with `pool_token_amount = 0` → `InvalidArgument`. |
| EXE-DAM-WDR-001 | + | U,I | DAMM withdraw with `min_sol_out` ≤ actual SOL out → succeeds. |
| EXE-DAM-WDR-002 | - | U | Withdraw when actual SOL out < `min_sol_out` → CPI fails with slippage error. |
| EXE-DAM-CLM-001 | + | U,I | DAMM claim_fees with `max_amount` capping reward → succeeds, capped. |

### 2.6 Token-2022 compatibility

| ID | Type | Layers | Case |
|---|---|---|---|
| EXE-T22-001 | + | I | DLMM lifecycle (init → add → claim → withdraw_close) on Token-2022 mint with no transfer hooks → identical behaviour to SPL-Token. |
| EXE-T22-002 | - | I | Token program account is SPL-Token but mint is Token-2022 (or vice versa) → rejected. |
| EXE-T22-003 | ~ | I | Token-2022 mint with transfer-fee extension → fees correctly accounted; assertions adjusted for transfer fee. |

---

## 3. Mixer API (`/mixer/*`)

| ID | Type | Layers | Case |
|---|---|---|---|
| API-MIX-001 | + | U,I | `POST /mixer/deposit` with valid commitment + siblings → 200, returns leaf_index and new_root, on-chain tx confirmed. |
| API-MIX-002 | - | U | `POST /mixer/deposit` with commitment that fails BN254 range check → 400 before submitting. |
| API-MIX-003 | - | U | `POST /mixer/deposit` with malformed body (missing commitment) → 400 schema error. |
| API-MIX-004 | - | I | `POST /mixer/deposit` when on-chain pool is paused → 409 with stable error code, no retry. |
| API-MIX-005 | ~ | I | `POST /mixer/deposit` racing against another deposit at same leaf_index → API serialises; both succeed at sequential indices. |
| API-MIX-006 | + | U,I | `GET /mixer/deposits` returns full deposit list ordered by leaf_index, sufficient to rebuild Merkle tree. |
| API-MIX-007 | + | U,I | `GET /mixer/merkle-path/:commitment` returns 20 siblings + leaf_index; computed root matches `GET /mixer/root`. |
| API-MIX-008 | - | U | `GET /mixer/merkle-path/:commitment` for unknown commitment → 404. |
| API-MIX-009 | + | U | `GET /mixer/root` returns current root and slot/timestamp. |
| API-MIX-010 | + | U,I | `GET /mixer/status` returns `{ paused, leaf_index, total_deposits, denomination, tree_capacity }`. |
| API-MIX-011 | ~ | I | After server restart, `/mixer/deposits` is rehydrated from on-chain `DepositEvent` logs and matches DB state. |
| API-MIX-012 | ~ | I | Hydration crosses a `DepositEvent` log truncation/missed slot — API backfills via `getSignaturesForAddress`. |
| API-MIX-013 | ~ | U | Rate limit: 31st deposit request in a minute → 429. |
| API-MIX-014 | + | U | Rate limit: 121st `GET /mixer/root` in a minute → 429. |

---

## 4. Relayer API (`/relayer/*`)

| ID | Type | Layers | Case |
|---|---|---|---|
| API-RLY-001 | + | U | `GET /relayer/info` returns `{ relayer_pubkey, fee_lamports, denomination, paused }`. |
| API-RLY-002 | + | U,I | `POST /relayer/withdraw` with valid proof + public inputs → relayer signs, submits, returns signature. |
| API-RLY-003 | - | U | `POST /relayer/withdraw` with proof failing off-chain snarkjs verification → 400, no on-chain submission. |
| API-RLY-004 | - | U | `POST /relayer/withdraw` with `fee` in public inputs ≠ relayer's configured fee → 400. |
| API-RLY-005 | - | I | `POST /relayer/withdraw` with already-spent nullifier (in-memory cache) → 409, no submission. |
| API-RLY-006 | - | I | `POST /relayer/withdraw` with nullifier unknown to local cache but on-chain NullifierAccount exists → on-chain rejection, surfaced as 409. |
| API-RLY-007 | - | I | `POST /relayer/withdraw` when relayer hot wallet has insufficient lamports for tx fee → 503 with `relayer_unfunded` code. |
| API-RLY-008 | ~ | U,I | `POST /relayer/withdraw` with root unknown to local mirror but valid on chain — relayer still submits and succeeds (don't fail-closed on stale local mirror). |
| API-RLY-009 | - | U | `POST /relayer/withdraw` with malformed proof bytes → 400. |
| API-RLY-010 | ~ | I | Two concurrent `/relayer/withdraw` for the same nullifier → exactly one succeeds, one returns 409. |
| API-RLY-011 | - | U | Missing or invalid relayer keypair at boot → server fails to start with explicit error. |

---

## 5. Positions API (`/positions/*`)

### 5.1 Intent + execute

| ID | Type | Layers | Case |
|---|---|---|---|
| API-POS-001 | + | U,I | `POST /positions/intents` with valid action=add-liquidity, mode=standard, pool, amount, bins → 201 with positionId, state=`draft`. |
| API-POS-002 | - | U | Intent with negative amount, zero amount, or amount > MAX → 400. |
| API-POS-003 | - | U | Intent with unknown poolSlug → 404. |
| API-POS-004 | - | U | Intent with `lower_bin_id > upper_bin_id` → 400. |
| API-POS-005 | - | U | Intent with mode not in `{standard, fast-private}` → 400. |
| API-POS-006 | + | U,I | `GET /positions/:id` returns position + activity timeline ordered by createdAt ASC. |
| API-POS-007 | - | U | `GET /positions/:id` for unknown id → 404. |
| API-POS-008 | + | I | `POST /positions/:id/execute` from `awaiting_signature` → state advances `awaiting_signature → funding_in_progress → executing → indexing → active`. |
| API-POS-009 | - | I | `POST /positions/:id/execute` from `draft` (no signature yet) → 409 with state-machine error. |
| API-POS-010 | - | I | `POST /positions/:id/execute` from terminal state (`active`, `closed`, `failed`) → 409. |
| API-POS-011 | ~ | I | Two concurrent executes on same id → exactly one transitions, the other gets 409. |
| API-POS-012 | + | I | Standard mode TTL of 10m exceeded with no signature → state moves to `failed` with stage `signing_timeout`. |
| API-POS-013 | + | I | Fast-private mode TTL of 15m with retry budget 1 — first auto-retry succeeds. |
| API-POS-014 | - | I | Fast-private retry budget exhausted → `failed` with stage `funding`. |

### 5.2 Claim & withdraw-close

| ID | Type | Layers | Case |
|---|---|---|---|
| API-POS-020 | + | U,I | `POST /positions/:id/claim` from `active` → activity records `claim` action; CPI sent. |
| API-POS-021 | - | U,I | `POST /positions/:id/claim` from non-active state → 409. |
| API-POS-022 | + | I | `POST /positions/:id/claim` is idempotent: replaying within same retry window does not double-claim (uses ExecutionSession dedupe). |
| API-POS-030 | + | U,I | `POST /positions/:id/withdraw-close` with bps=10_000 from `active` → position transitions to `closed`. |
| API-POS-031 | + | U,I | `POST /positions/:id/withdraw-close` partial → position remains `active` with reduced liquidity. |
| API-POS-032 | - | U | `withdraw-close` with bps=0 or bps>10_000 → 400. |
| API-POS-033 | - | I | `withdraw-close` from `failed` → 409 with recovery guidance pointing to recovery flow. |

### 5.3 State machine & recovery

| ID | Type | Layers | Case |
|---|---|---|---|
| API-POS-040 | + | U | All 11 states defined; transitions form a DAG with allowed back-edges only `failed → recovery → previous`. |
| API-POS-041 | - | U | Every undefined transition rejected with `InvalidTransition`. |
| API-POS-042 | + | U | Each of 7 failure stages maps to a non-empty `safeNextStep` in recovery catalogue. |
| API-POS-043 | + | U | Activity row written atomically in same DB transaction as state change. |
| API-POS-044 | ~ | I | DB transaction rollback during state change leaves state unchanged AND no orphan activity row. |

---

## 6. Executor tx-build API (`/executor/*`)

| ID | Type | Layers | Case |
|---|---|---|---|
| API-EXE-001 | + | U,I | `POST /executor/init-position-tx` returns unsigned ix matching on-chain account-meta order. |
| API-EXE-002 | + | U | `POST /executor/add-liquidity-tx` returns ix with stealth as signer + correct bin arrays after width adjustment. |
| API-EXE-003 | + | U | `POST /executor/claim-fees-tx` returns ix targeting stored exit_recipient. |
| API-EXE-004 | + | U | `POST /executor/withdraw-close-tx` accepts bps and bin range, returns ix. |
| API-EXE-005 | + | U,I | `GET /executor/pool-authority` returns deterministic PDA for `(stealth, lb_pair)`. |
| API-EXE-006 | - | U | Tx-build endpoints with unknown pool → 404. |
| API-EXE-007 | - | U | Tx-build endpoints with width that would cross more than 2 bin arrays → 400. |
| API-EXE-008 | ~ | I | Tx built by API and signed by stealth client signs to a tx that lands on chain unmodified (no missing accounts). |

---

## 7. DLMM data API (`/dlmm/*`)

| ID | Type | Layers | Case |
|---|---|---|---|
| API-DLM-001 | + | U,I | `GET /dlmm/pools` returns paginated pool list, sorted, with TVL & APR. |
| API-DLM-002 | + | U | `GET /dlmm/pools` with `?token=<mint>` filters by either side. |
| API-DLM-003 | - | U | `GET /dlmm/pools/:address` with malformed pubkey → 400. |
| API-DLM-004 | - | U | `GET /dlmm/pools/:address` for unknown pool → 404. |
| API-DLM-005 | + | U,I | `GET /dlmm/pools/:address/bins` returns bin liquidity around active bin. |
| API-DLM-006 | + | U | `GET /dlmm/pools/:address/ohlcv` returns OHLCV; missing intervals filled or omitted consistently. |
| API-DLM-007 | + | U | `GET /dlmm/stats` returns protocol metrics. |
| API-DLM-008 | ~ | I | When upstream Meteora/Jupiter is down, endpoints respond with 503 and stale-cache flag, never 500. |

---

## 8. Misc API (health, prices, waitlist)

| ID | Type | Layers | Case |
|---|---|---|---|
| API-MISC-001 | + | U | `GET /health` returns 200 with build info + DB ping. |
| API-MISC-002 | + | U,I | `GET /prices` returns Jupiter-v3 prices for tracked mints. |
| API-MISC-003 | ~ | I | `GET /prices` falls back to last-known cache when Jupiter is rate-limited; response carries `stale=true`. |
| API-MISC-004 | + | U | `POST /waitlist` with valid email → 201; duplicate email → 200 (idempotent). |
| API-MISC-005 | - | U | `POST /waitlist` with invalid email (RFC 5321) → 400. |

---

## 9. Frontend (`octora-web`)

### 9.1 Wallet & shell

| ID | Type | Layers | Case |
|---|---|---|---|
| FE-WAL-001 | + | E,M | Connect Phantom, Backpack, Solflare → wallet pubkey rendered, balance updates on slot. |
| FE-WAL-002 | + | M | Disconnect wallet → app returns to landing CTA, no stale balance. |
| FE-WAL-003 | - | M | Reject signature in wallet → UI shows actionable error, position state moves to `awaiting_signature` (not failed). |
| FE-WAL-004 | ~ | M | Switch wallet mid-flow → in-flight position is preserved but cannot be signed by new wallet; UI explains. |

### 9.2 Pool browser

| ID | Type | Layers | Case |
|---|---|---|---|
| FE-POOL-001 | + | E,M | Browse list, filter by token mint, sort by TVL/APR. |
| FE-POOL-002 | + | M | Pool detail page renders bin chart and OHLCV. |
| FE-POOL-003 | - | M | Direct-link to unknown pool address → "pool not found" page, not crash. |
| FE-POOL-004 | ~ | M | Pool with zero liquidity → bin chart renders empty state, no division-by-zero. |

### 9.3 Deposit / add-liquidity flow

| ID | Type | Layers | Case |
|---|---|---|---|
| FE-DEP-001 | + | E,M | Standard mode: amount + bin range → intent → sign → private deposit → add-liquidity → active. |
| FE-DEP-002 | + | E,M | Fast-private mode: same flow with auto-retry on relayer failure. |
| FE-DEP-003 | - | M | Amount > wallet balance → submit disabled with explanation. |
| FE-DEP-004 | - | M | Bin range outside pool's defined range → submit disabled. |
| FE-DEP-005 | ~ | M | Single-sided SOL with narrow range that triggers width adjustment → UI surfaces the adjusted range before signing. |
| FE-DEP-006 | ~ | M | Page refresh between intent creation and signature → resumes from saved state, secrets/nullifiers re-derivable from local storage (or explicitly require a fresh intent — pin behaviour). |
| FE-DEP-007 | - | M | Browser denies WebCrypto / WASM → ZK proof cannot be generated; UI shows clear blocker. |

### 9.4 Position management

| ID | Type | Layers | Case |
|---|---|---|---|
| FE-POS-001 | + | E,M | Position detail shows current value, accrued fees, bin distribution, activity timeline. |
| FE-POS-002 | + | M | Claim button: only enabled when accrued fees > dust threshold. |
| FE-POS-003 | + | M | Withdraw-close partial slider 0–100% with live preview of returned SOL. |
| FE-POS-004 | ~ | M | Position in `failed` shows recovery copy from `safeNextStep`, with retry CTA when applicable. |

### 9.5 Test pages

| ID | Type | Layers | Case |
|---|---|---|---|
| FE-TEST-001 | + | E,M | `IntegratedTestPage` runs full deposit→add→claim→withdraw end-to-end on devnet/localnet. |
| FE-TEST-002 | + | E,M | `MixerTestPage` runs deposit→withdraw isolated, surfaces commitment + nullifier for inspection. |

---

## 10. End-to-end (cross-component)

| ID | Type | Layers | Case |
|---|---|---|---|
| E2E-001 | + | E | Localnet: full standard private deposit → add-liquidity → claim → withdraw-close lifecycle. Origin wallet never appears as signer of add-liquidity. |
| E2E-002 | + | E | Same as E2E-001 in fast-private mode with one induced relayer failure → auto-retry succeeds. |
| E2E-003 | ~ | E | Two users deposit, both withdraw to distinct stealth wallets, both add liquidity to same pool — neither's nullifier or stealth is correlatable to the other's commitment (multi-user anonymity check in code, not just claim). |
| E2E-004 | - | E | Withdraw with proof against root that has fallen out of ring buffer → relayer rejects with `RootNotFound`; UI surfaces "proof expired, regenerate" copy. |
| E2E-005 | ~ | E | API restarts mid-flow between deposit and withdrawal → frontend resumes, hydrated deposit cache is consistent with chain. |
| E2E-006 | ~ | E | Solana RPC outage during execute → position parks in `executing` until RPC returns, then advances; no double-submit. |
| E2E-007 | - | E | Origin wallet is a known sanctioned/blocked address (if list configured) → API rejects intent. |
| E2E-008 | ~ | E | Localnet → devnet → mainnet config switch via env vars only (no code changes) — programs IDs rotate cleanly (mirrors `chore(programs): rotate programs IDs`). |

---

## 11. Cross-cutting (rate limiting, persistence, observability, security)

| ID | Type | Layers | Case |
|---|---|---|---|
| OPS-RATE-001 | ~ | I | Per-client write rate limiter resets after 60s window. |
| OPS-RATE-002 | ~ | I | Per-client read rate limiter independent of write bucket. |
| OPS-RATE-003 | - | I | Distributed deployment shares limiter state (or document explicitly that it does not, and test the per-instance bound). |
| OPS-PERSIST-001 | + | I | Server restart preserves position state, activity timeline, and reconciliation rows. |
| OPS-PERSIST-002 | ~ | I | Concurrent writers to same position serialise via DB; no lost activity rows. |
| OPS-PERSIST-003 | ~ | I | Indexer reconciliation is idempotent: rerunning against same signature does not create duplicate rows. |
| OPS-OBS-001 | + | M | Every state change has a structured log with `positionId`, `from`, `to`, `cause`. |
| OPS-OBS-002 | + | M | Errors carry stable error codes; no raw stack traces returned to client. |
| OPS-SEC-001 | - | U,I | Origin wallet pubkey never appears in any `/positions/*` response or any log line for a private-mode position. |
| OPS-SEC-002 | - | U | Mixer secret/nullifier never sent over the wire (verify by inspecting all client→server payloads in fixture-based test). |
| OPS-SEC-003 | - | I | Relayer keypair file is read-only at boot; server refuses to start if file is world-readable. |
| OPS-SEC-004 | - | U,I | Input validation: all string inputs length-bounded, all numeric inputs range-bounded; fuzz tests for endpoint schemas. |
| OPS-SEC-005 | - | I | CORS: only configured origins allowed; preflight rejected for others. |
| OPS-SEC-006 | - | I | No endpoint discloses internal DB ids that would let a client enumerate other users' positions. |
| OPS-DEPLOY-001 | + | M | Localnet bootstrap script (`feat(dev): localnet support`) brings up validator, deploys both programs, seeds devnet pool clones, and reaches green health check end-to-end. |

---

## 12. Coverage matrix (where each layer is responsible)

| Concern | Primary layer | Secondary layer |
|---|---|---|
| Pure crypto (Poseidon, Merkle math, BN254 range) | U | — |
| Anchor account / signer / PDA constraints | U (`anchor test`) | I |
| State machine transitions | U | I |
| HTTP schema validation | U | I |
| Mixer ↔ relayer ↔ chain wiring | I | E |
| Multi-user anonymity & root-history semantics | I | E |
| Wallet UX, error copy, recovery hints | M | E |
| Rate limit, persistence, restart recovery | I | M |
| Privacy invariants (origin pubkey leakage) | U | I + M |

A test belongs at the lowest layer where it can be both deterministic and meaningful. Push higher only when the lower layer cannot reach the invariant — for example, "origin wallet not visible in logs" needs both a unit assertion on the formatter and a manual log inspection during E2E.

---

## 13. Implemented test files (mapping)

Each new test file calls out the TC-IDs it covers in its file header. Index:

**API (`octora-api`)**
- `src/modules/mixer/__tests__/rate-limit.test.ts` — `OPS-RATE-001/002`, `API-MIX-013/014`
- `src/modules/mixer/__tests__/mixer.controller.test.ts` — `API-MIX-001/002/004/006/010`
- `src/modules/relayer/__tests__/relayer.controller.test.ts` — `API-RLY-001/002/004/009`, `OPS-SEC-006`
- `src/modules/waitlist/__tests__/waitlist.routes.test.ts` — `API-MISC-004/005`
- `src/modules/positions/__tests__/position.routes.state-machine.test.ts` — `API-POS-002/005/007/010/021`
- `src/modules/dlmm/__tests__/dlmm.routes.schema.test.ts` — `API-DLM-002/003/008`
- `src/test-kit/vitest-env.ts` — test-only env injection (used by all `createApp()` tests)

**Frontend unit (`octora-web`)**
- `src/lib/__tests__/bins.test.ts` — `FE-POOL-004`, `FE-DEP-005` (data layer)
- `src/lib/__tests__/pnl.test.ts` — `FE-POS-001` (data layer)
- `src/lib/__tests__/stealthVault.test.ts` — `FE-WAL-003`, `FE-DEP-006/007`, `OPS-SEC-002`

**Frontend e2e (`octora-web`)**
- `e2e/pool-discovery.spec.ts` — `FE-POOL-001/003/004`, `FE-WAL-001`

**Findings surfaced while implementing**
- `API-POS-021` / `API-POS-010` — current implementation throws a plain `Error`
  in `position.service.ts` so Fastify maps state-machine violations to HTTP
  500. The test plan calls for 4xx (typically 409). The new tests assert
  today's behaviour exactly; a future fix to introduce a typed
  `StateTransitionError` with `statusCode: 409` will surface as a clean test
  diff.
- `EXE-DLM-INIT-009` (exit_recipient = PoolAuthority self-loop) is not yet
  pinned by an automated test. The on-chain executor program needs reading
  to confirm whether the constraint is enforced; tracked here so future
  program work picks it up.

## 14. Maintenance rules

1. Every PR that changes behaviour must either map to existing `TC-*` IDs or add new ones in the same PR.
2. When a bug is fixed, add a regression case here with a new ID and a `Origin: <commit/issue>` note in the row.
3. Cases removed from this doc must be marked `DEPRECATED` and kept for at least one release so historical test runs remain interpretable.
4. The `octora-coverage-gaps.ts` file is a living checklist for known gaps; once a gap has a stable test elsewhere, fold it into the matching `MIX-*` / `EXE-*` row and remove it from the gaps file.
