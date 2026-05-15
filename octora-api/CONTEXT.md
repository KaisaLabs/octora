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
The private deposit -> add-liquidity fallback path uses the existing Position execution state machine, not a parallel machine. The fallback substates are `DEPOSITED -> LP_PENDING -> LP_FAILED -> { LP_RETRIED | PARKED | WITHDRAWN }`, with `LP_PENDING -> LP_DONE` and retry paths back through `LP_RETRIED`. `LP_DONE` and `WITHDRAWN` clear the persisted deposit intent.

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
