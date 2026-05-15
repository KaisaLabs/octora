# Backend Orchestration

The Fastify service that drives Octora's three privacy flows. Owns the off-chain orchestration: Position lifecycle state machine, mode policy, recovery catalog, and on-chain reconciliation. On-chain primitives (Mixer Pool, DLMM Position, Commitments, Nullifiers) are defined in the [on-chain glossary](../programs/CONTEXT.md); this glossary covers the backend-specific terms that sit above them.

## Language

### Position model

**Position**:
The orchestration entity for one user intent — a single LP action the user wants run privately. One DB row per intent. Owns its lifecycle state, recovery context, and the Stealth Wallet that will hold the DLMM Position.
_Avoid_: Order, Intent, Session (as a synonym for Position)

**DLMM Position**:
The on-chain Meteora position account that a Stealth Wallet owns. Always qualified — never call it just "Position" inside this context.
_Avoid_: LP Position (when ambiguous)

**Stealth Wallet**:
A single-use, freshly generated ephemeral keypair with no derivation from the user's main wallet. Owns exactly one DLMM Position. Funded by a mixer withdrawal and drained at close.
_Avoid_: Ephemeral Wallet, Burner Wallet, Position Wallet, Relay Wallet

**Encrypted Seed**:
The AES-256-GCM blob produced by encrypting a Stealth Wallet's seed with a key derived from the user's `signMessage()`. The origin wallet is the *only* way to recover a Stealth Wallet — no backend escrow, no passphrase fallback (see ADR-0002). Losing the origin wallet permanently locks the funds in the corresponding DLMM Position.
_Avoid_: Backup seed, recovery blob

### Execution

**Execution Mode**:
The privacy/speed choice for a Position. Two variants:
- **standard** — direct execution; the mixer is skipped entirely. Faster, no privacy. Built for the speed-first path.
- **fast-private** — full mixer path. Slower in practice (longer funding TTL, anonymity-set wait). May fall back to **standard** mid-flight when recovery requires it.

**Mode Fallback**:
A mid-flight downgrade from **fast-private** to **standard**. Runs automatically when a recovery catalog entry sets `surfaceDowngradeDisclosure` — the downgrade is *not* gated on user ACK. Disclosure is surfaced **after** the fact via an Activity Record and a UI banner. See ADR-0001.
_Avoid_: Mode downgrade (unless paired with "Fallback")

**Pod**:
A runtime sandbox tied to one Position. Created on transition into execution. Single Pod per Position by default; reusable *within* a Position when `podReuseWithinPosition` is true. Never reused across Positions.

**Funding TTL**:
Per-mode deadline for the user's wallet to fund the Position before the flow aborts. Configured via `modePolicy[mode].fundingTtlMinutes`.

### Recovery

**Failure Stage**:
The lifecycle phase where a failure occurred — e.g. `signature`, `pre-funding`, `funding-partial`, `venue-submission`. Drives the matching **Recovery Guidance**.

The **boundary between `pre-funding` and `funding-partial`** is whether any user funds left the origin wallet:
- `pre-funding` — flow stopped before any movement. Idempotent: user can retry from scratch.
- `funding-partial` — funds moved but the flow didn't finish cleanly. On-chain state is ambiguous, so the safe next step is `contact-support`, not `retry`.

**Recovery Guidance**:
The catalog entry for a Failure Stage — user-facing headline + message, a terminal flag, an optional **Mode Fallback** target, and a **Safe Next Step**.

**Deposit LP Fallback State**:
The two-phase `Private Deposit -> Position Open` path — primary mainline after ADR-0004 — uses the existing Position execution state machine, not a parallel machine. Conceptually the fallback cluster is a sub-state of the `funding-partial` Failure Stage (ADR-0004 promoted it from "defense-in-depth floor" to the primary path); concretely it ships as named variants of the `ExecutionState` union so the same `canTransition` guard rejects illegal jumps without a second machine. The substates are:

- `DEPOSITED` — `mixer.deposit` confirmed; a **Persisted Deposit Intent** row is created keyed by nullifier hash.
- `LP_PENDING` — user-signed `withdraw + add_liquidity` submitted from the Stealth Wallet.
- `LP_FAILED` — tx revert / timeout; the UI exposes the 3-button recovery panel (retry / park / withdraw).
- `LP_RETRIED` — user chose **Retry private LP**; re-arms an attempt. Loops back to `LP_PENDING`-shaped behaviour.
- `PARKED` — user chose **Park for later**; persisted intent survives so the Resume in pool CTA can resume.
- `WITHDRAWN` — terminal; reached via the user-signed Recover Funds path (dust/04). Clears the persisted intent.
- `LP_DONE` — terminal; DLMM Position minted to the Stealth Wallet. Clears the persisted intent.

Permitted transitions: `DEPOSITED -> LP_PENDING -> { LP_FAILED | LP_DONE }`; `LP_FAILED -> { LP_RETRIED | PARKED | WITHDRAWN }`; `PARKED -> { LP_RETRIED | WITHDRAWN }`; `LP_RETRIED -> { LP_PENDING | LP_FAILED | LP_DONE }`. `LP_DONE` and `WITHDRAWN` are terminal and clear the persisted deposit intent via the `Position` aggregate.

**Private Position Close State**:
The three-tx Private Position Close mainline (Flow 3 in CONTEXT-MAP.md, close/01) ships as a sub-state cluster of the existing Position state machine — same option (a) precedent the Deposit LP Fallback cluster set: named variants of the `ExecutionState` union so the existing `canTransition` guard rejects illegal jumps without a parallel machine. Mainline: `active -> CLOSING -> (SWAPPING ->)? REMIXING -> CLOSED`. The substates are:

- `CLOSING` — relayer submitted `dlmm_withdraw_close` (Executor CPI to Meteora: claim fees + remove all liquidity + close the DLMM Position account).
- `SWAPPING` — relayer is swapping the stealth's non-SOL residual to SOL via Meteora (`dlmm_swap`). Skipped when the residual is at or below `CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS` (1000 lamports of the other-side token's smallest unit, a named constant in `position.close.service.ts`) — that residual stays at the Stealth Wallet as documented sub-denom dust per ADR-0003.
- `REMIXING` — relayer submitted `mixer.deposit` for one denomination of SOL into the same-denomination Mixer Pool the original deposit used.
- `CLOSED` — terminal; the mixer accepted a fresh Commitment that the user can later withdraw to a new recipient. The connection between the original deposit and the post-close re-mix stays inside the Mixer Pool's Merkle Tree.
- `CLOSE_FAILED`, `SWAP_FAILED`, `REMIX_FAILED` — terminal failure for each leg. Each carries a matching Failure Stage (`close-submission`, `swap-submission`, `remix-submission`) and `safeNextStep: contact-support` until close/03's user-signed close-recovery escape lands. No Mode Fallback applies — the close flow has no `fast-private`/`standard` split.

Permitted transitions: `active -> CLOSING`; `CLOSING -> { SWAPPING | REMIXING | CLOSE_FAILED }`; `SWAPPING -> { REMIXING | SWAP_FAILED }`; `REMIXING -> { CLOSED | REMIX_FAILED }`. All `*_FAILED` and `CLOSED` are terminal.

The three txs are serial and relayer-signed (not atomic — ADR-0003 blocks atomic compounds). A bot watching the chain sees only relayer-signed activity: the DLMM Position closes, any non-SOL residual swaps to SOL, and one denomination of SOL deposits into the Mixer Pool. The connection between the original deposit and the post-close anonymity-set entry stays inside the Mixer Pool's Merkle Tree.

**Close Quote**:
The pre-flight read returned by `GET /positions/:positionId/close-quote` (close/02). Computed from current DLMM bin state + accrued fees + a DLMM swap quote, it gives the close confirmation modal enough to render an honest preview before the user kicks the close orchestrator. Shape: `{ closeable: true, estimate, swap?, denomination, dustLamports }` on success — the `swap` field is omitted when the stealth's post-close non-SOL residual is at or below `CLOSE_SWAP_DUST_THRESHOLD_LAMPORTS` (mirrors the orchestrator's swap-skip rule, so the UI never previews a step the backend would skip). On a Token-2022 mint precheck refusal (close/04's `assertExecutorSupportsMint`), the shape switches to `{ closeable: false, reason: "unsupported_mint", details: { mint, extension } }` so the frontend's `useCanClosePosition` hook can disable the Close button with a v2 badge without an extra round-trip.
_Avoid_: Close estimate, Close preview (close-quote is the canonical noun for this read).

**Slippage Tolerance**:
The user-set cap on how much the swap leg's realized output may deviate from the pre-flight `Close Quote`. Expressed in basis points, range [10, 500] (0.1 %–5 %), default 50 bps (0.5 %) — bounds rejected at the schema level on `POST /positions/:positionId/close` (close/02). The orchestrator threads the value into `CloseOrchestrationAdapter.submitSwap`; the adapter computes `min_amount_out = expectedOutLamports * (1 - slippageBps/10000)` and threads that into the on-chain `dlmm_swap` ix. A realized output below `min_amount_out` reverts the ix and lands the Position in `SWAP_FAILED` (recovery via close/03). Live recompute of `min_amount_out` is purely client-side as the user changes the selector — no extra network call.
_Avoid_: Slippage cap, Max slippage (Slippage Tolerance is the canonical name; the wire field is `slippageBps`).

**Persisted Deposit Intent**:
The off-chain `{commitment, intended_pool, denom_lamports, expires_at}` row keyed by nullifier hash that the backend writes when a Position enters `DEPOSITED`. The user holds the nullifier preimage off-chain (custodial-less by design); the backend only sees the hash. Cleared on `LP_DONE` or `WITHDRAWN`. Without it, a tab close between deposit and add-liquidity would orphan the user's funds — with it, the funds are always discoverable from the user's Encrypted Seed plus their main wallet signature.
_Avoid_: Stuck Deposit Record, Pending Position State

**Safe Next Step**:
Enum of safe user actions: `wait | retry | refresh | contact-support`. Always shown alongside guidance.

**Activity Record**:
Audit-log entry for each Position state change. Carries the action, state, headline, detail, and (where relevant) Recovery Guidance.

### Mixer-side (orchestration view)

**Anonymity Set Guard**:
The off-chain gate that refuses to submit a withdraw until the Mixer Pool has at least `MIN_ANONYMITY_SET = 20` unspent Commitments. Lives in the backend, not on-chain.

**Reconciliation**:
Confirming that the on-chain transaction for a Position has landed. The indexer stores one signature per Position; once the signature is registered, the state machine flips `indexing → active`. Today this is the entire scope — no bin-balance or Mixer leaf-index alignment yet.
_Avoid_: Indexing (verb form is fine, but "the Indexer does Reconciliation" is the canonical phrasing)

## Relationships

- A **Position** owns exactly one **Stealth Wallet** and (after Open) one **DLMM Position**.
- A **Position** is bound to one **Execution Mode** at creation, with optional **Mode Fallback** during recovery.
- A **Position** runs in one **Pod**; the Pod may be reused within that Position only.
- Every state change on a **Position** emits an **Activity Record**, optionally with **Recovery Guidance**.
- Each **Stealth Wallet** seed is stored client-side as an **Encrypted Seed**, recoverable from the user's wallet signature.

## Example dialogue

> **Dev:** "If the mixer withdraw fails after pre-funding, do we keep the Stealth Wallet?"
> **Domain expert:** "Yes — the Stealth Wallet stays bound to that Position. The user retries the withdraw, or accepts a Mode Fallback to **standard** with disclosure. We never recycle a Stealth Wallet across Positions."

## Flagged ambiguities

- **Execution Mode** names suggest a speed/privacy axis but the field values reverse that reading: `fast-private` has the *longer* funding TTL and may fall back to `standard`. Canonical meaning is recorded above (**standard** = direct, no privacy; **fast-private** = full privacy path). Worth renaming if a clean refactor window opens.
- "Position" historically meant both the orchestration entity and the on-chain DLMM account. Resolved: on-chain is always **DLMM Position**.
- "Venue" appears in `recoveryCatalog` (e.g. `venue-submission`) — refers to Meteora. Not promoted to a glossary term; use "Meteora" or "DLMM" explicitly elsewhere.
- `surfaceDowngradeDisclosure` means "surface disclosure post-hoc" after the fallback has already run; it is not a user ACK gate.
