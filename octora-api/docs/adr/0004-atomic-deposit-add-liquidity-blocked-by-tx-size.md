# Atomic user-signed `mixer.deposit + DLMM add_liquidity` is blocked by tx-size, not CU

A surfpool-backed measurement (`tests/octora-cu-measure-compound.ts`, commit `f3ee86c`) of a user-signed atomic `mixer.deposit + DLMM add_liquidity` flow produces these numbers:

| Component | CU | Bytes |
|---|---|---|
| `mixer.deposit` alone | 30,161 | 349 |
| DLMM `add_liquidity` (tight range) | 143,705 | — |
| DLMM `add_liquidity` (wide / cold bin arrays) | 357,016 | — |
| **Atomic upper-bound (deposit + add_liquidity)** | **173,866 – 387,177** | **1268** |

The CU budget is not the constraint — the upper-bound atomic tx is ~387K CU, comfortably under Solana's 1.4M ceiling. **The binding constraint is transaction size: 1268 bytes vs. Solana's 1232-byte packet limit. Over by 36 bytes.**

## Decision

The user-signed atomic deposit+addLP path (dust/02) is **infeasible at current account-encoding density.** Octora's default Private Deposit → Position Open path is therefore the two-phase flow (dust/03), with persisted intent + always-available **Recover Funds** fallback (dust/04). The atomic path can be revisited if and only if one of the mitigations below brings the tx under 1232 bytes.

## Constraint named

Per dust/01's rescoped AC ("which of CU vs tx-size vs bin-array init bites?"): **tx-size** bites. CU is comfortable. Bin-array init was not isolated as a separate cost because the dominant byte cost is account-list encoding (DLMM `add_liquidity` carries many bin-array, position, and reserve accounts), not instruction data.

## Considered mitigations (not adopted as of 2026-05-15)

- **Address Lookup Tables (LUT)** — most likely path under the deficit. LUT-resolved addresses occupy 1 byte each in the tx vs. 32 bytes raw. Even a modest LUT (5–6 frequently-referenced accounts: relayer, mixer pool PDA, position PDA, reserve token accounts) recovers >150 bytes — well over the 36-byte deficit. Cost: relayer must publish + maintain the LUT; users sign txs that reference it.
- **Split bin-array init into a non-fund-moving prep tx** — safe to fail, no user funds at risk. Cuts bin-array account refs from the fund-moving tx. Cost: two signatures on the cold path (first deposit into a pool with un-initialised bin arrays), one signature on the warm path.
- **Account compression on DLMM position state** — out of Octora's control; requires Meteora to ship the primitive.

This ADR records the decision to not adopt any of these mitigations in the current MVP scope. The two-phase flow (dust/03) ships first.

## Scope

This ADR does **not** apply to the relayer-signed compound ix `mixer.withdraw → DLMM add_liquidity` (dust/05). That ix has a different account list and a different signer, so its tx-size profile is independent and remains gated by ADR-0003 (the Mixer↔DLMM CPI ownership boundary), not by ADR-0004.

## Consequences

- dust/02 (user-signed atomic deposit+addLP) is closed as wontfix at current density. The "stuck-funds-by-construction-impossible" guarantee it promised is downgraded to "stuck-funds-recoverable-via-the-Recover-Funds-fallback" (dust/04).
- dust/03 (two-phase deposit→LP state machine) is promoted from defense-in-depth to the primary path.
- If/when an LUT-based version of the atomic tx is built, this ADR is superseded by a future ADR that records the LUT design and re-measures tx-size.
