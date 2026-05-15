# ADR-0003: Compound Mixer/DLMM CPI Remains Fail-Closed

Date: 2026-05-15

## Status

Accepted

## Context

Issues 01, 05, and 06 from `.scratch/dust-and-stuck-funds/` ask for atomic paths that remove Stealth Wallet free-balance intervals:

- `mixer.withdraw -> dlmm.add_liquidity`
- `dlmm.claim_fee -> mixer.deposit`

The current on-chain boundary is different. `octora-mixer` owns the Mixer Pool, Nullifier Account, Commitment Account, Merkle Tree updates, proof validation, and SOL transfers. `octora-executor` owns DLMM CPI validation and signer re-pinning through its PoolAuthority PDA. The programs do not currently CPI each other, and the Executor does not depend on the Mixer crate or IDL.

The existing Meteora CPI wrappers also operate on SPL token accounts. A mixer withdrawal releases native SOL lamports to a recipient; adding liquidity to a DLMM SOL pair needs the SOL side present as wrapped SOL in the correct token account and synchronized before the DLMM CPI. Routing that value through the Stealth Wallet token/free balance would reintroduce the dust state these issues are meant to remove.

For the fee-claim path, `claim_fee2` pays claimed fees into user token accounts. The requested residual rule says sub-denomination dust must be compounded back into the DLMM Position without leaving the position account. The available wrapper surface only claims out to token accounts and adds liquidity from token accounts; it does not provide a single primitive that leaves the residual inside the DLMM Position while depositing the floored amount into the Mixer Pool.

## Decision

Export two Executor entrypoints as explicit scaffolding, but keep them fail-closed:

- `compound_withdraw_add_liquidity`
- `compound_claim_fees_deposit`

Both validate canonical Mixer and DLMM program IDs and then return `ExecutorError::CompoundCpiUnsupported`. `compound_claim_fees_deposit` additionally enforces the floor-round invariant:

```text
requested_deposit_amount == floor(claimed_fee_amount / denomination) * denomination
```

This makes the interface visible to IDL/build tooling without pretending the atomic privacy primitive has landed.

## Consequences

- Issue 05 and 06 are not implemented as live fund-moving primitives.
- The backend must not route production traffic to these entrypoints until this ADR is superseded.
- A future implementation must either move the compound primitive into a program that owns both mixer proof verification and DLMM CPI routing, or introduce a reviewed Mixer CPI interface that can pay directly into a DLMM-ready WSOL/token account without exposing an intermediate Stealth Wallet balance.
- The fee-claim path also needs a Meteora-supported or locally proven residual-reinsert path; otherwise residual dust leaves the DLMM Position and violates the issue.
- This ADR lives under `octora-api/docs/adr/` because Anchor treats every direct child of `programs/` as a program crate; creating `programs/docs/adr/` breaks `anchor build`.

## Verification Notes

No Surfpool CU/transaction-size prototype was recorded in this repo because the available local interfaces cannot build a faithful single transaction: the missing parts are cross-program mixer invocation semantics and SOL-to-DLMM-token routing, not merely compute budget. Any later CU measurement should target the superseding implementation, not this scaffold.
