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

- Atomic compound ix prototype (Issue 1)
- Denom ladder `{0.1, 1, 5, 10}` + floor-round fee-claim (Issue 2)
- `LP_FAILED` state machine + user-signed recover path (Issue 3)

## Prior requests

- Internal design doc `docs/dust-and-stuck-funds-design.md` — triage 2026-05-15
