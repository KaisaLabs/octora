# Dust Sweeper Service

Octora does not run a dust-sweeper service to collect sub-denom residual amounts from stealth wallets or LP positions.

## Why this is out of scope

A sweeper service is a band-aid for an architectural gap, not a fix. Once mixer-withdraw and pool-deposit are bridged by an **atomic compound instruction**, the gap where dust accumulates ceases to exist:

```
mixer.withdraw -> CPI pool.add_liquidity
       \-> position NFT owner = stealth
       \-> sub-denom dust never lands in stealth account
```

For fee-claim, the same principle holds: claimed fees are floor-rounded to the nearest denom multiple and atomically redeposited via `pool.claim_fee -> mixer.deposit`. Residual sub-denom dust is **compounded back into the LP position** itself — it stays inside the user's own position, growing the next claim.

Net effect:

- No off-chain sweeper service to run, monitor, or fund
- No protocol treasury siphon to disclose
- No new account taxonomy ("sweep destination", "dust collector", etc.)
- No additional linkage surface for copy-trader bots (a sweeper is itself a heuristic anchor)

The right fixes are tracked elsewhere:

- Atomic compound ix prototype (Issue 01)
- Position-open compound primitive (Issue 05)
- Fee-claim compound primitive with floor-rounding (Issue 06)
- Denom ladder `{0.1, 1, 5, 10}` readiness (Issue 07)
- `LP_FAILED` state machine + user-signed recover path (Issues 03 and 04)

## Current status (2026-05-15) — protocol-level dust is DEFERRED, not fixed

The canonical replacement for an off-chain sweeper is the atomic compound ix pair tracked by Issues 05 and 06:

- `.scratch/dust-and-stuck-funds/issues/05-compound-ix-mixer-withdraw-pool-add-liquidity.md`
- `.scratch/dust-and-stuck-funds/issues/06-compound-ix-claim-fee-mixer-deposit.md`

**Both currently exist only as fail-closed scaffolds** in `octora-executor` — the entrypoints are exported and validate accounts, but they return `CompoundCpiUnsupported` and move zero lamports. See ADR `octora-api/docs/adr/0003-compound-mixer-dlmm-cpi-remains-fail-closed.md` for why the Mixer ⇄ DLMM CPI boundary cannot be crossed in the current program layout, and what the redesign requires.

Concretely this means:

- The architectural gap that produces sub-denom dust at the stealth wallet is **still open** at the protocol level.
- The withdraw → add-liquidity and claim-fee → redeposit primitives that would *close* the gap are not live.
- Until those primitives ship, the dust outcome is an **accepted, documented protocol behaviour** — not a solved problem.

### Why the sweeper is still rejected anyway

A reader noticing that the canonical fix has not landed might reasonably ask: "if the replacement is vapourware, why not run the sweeper as a stopgap?" The answer has not changed:

- A sweeper papers over an **architectural gap**, it does not close it. Shipping it would make the gap permanently invisible to anyone reading the codebase and would dilute the pressure to actually land Issues 05 + 06.
- The four objections listed above (off-chain service to run/monitor/fund, treasury siphon to disclose, new account taxonomy, fresh linkage surface for copy-trader bots) are independent of whether the canonical fix exists. They apply to *any* sweeper deployment.
- A user-controlled, opt-in, link-revealing manual sweep from the stealth wallet to the user's main wallet already exists in the frontend (`octora-web/src/lib/privateLifecycle.ts → runSweepStealthToMain`) and is gated behind an explicit acknowledgement. That is a UX accommodation for stuck residue under the smallest denomination, not a protocol-run sweeper service. It is the **only** form of "sweep" Octora ships.

The rejection in this file refers to a protocol- or treasury-run sweeper. That remains out of scope. The contingency is loud: until ADR-0003 is unblocked and Issues 05 + 06 land for real, dust at the protocol level is a known deferred item, not a fixed one.

## Prior requests

- Internal design doc `docs/dust-and-stuck-funds-design.md` — triage 2026-05-15
