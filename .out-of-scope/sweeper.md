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

Current implementation note: `octora-executor` exports fail-closed scaffold entrypoints for Issues 05 and 06, but ADR `octora-api/docs/adr/0003-compound-mixer-dlmm-cpi-remains-fail-closed.md` records why the real fund-moving CPI is not live yet. This file remains the rejection record for any off-chain sweeper workaround while the compound primitive is unresolved.

## Prior requests

- Internal design doc `docs/dust-and-stuck-funds-design.md` — triage 2026-05-15
