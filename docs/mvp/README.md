# Octora MVP Plan

A staged checklist to take Octora from "architecturally complete, functionally hollow" to a shipped, usable DLMM portfolio manager with privacy as a differentiator.

## How to use this folder

Three phase files, each independently shippable:

1. [`phase-1-it-actually-works.md`](./phase-1-it-actually-works.md) — Non-private DLMM portfolio manager. The goal: a user connects a wallet, opens a real LP position on Meteora, sees it in the portfolio, and can claim/close it.
2. [`phase-2-privacy-mvp.md`](./phase-2-privacy-mvp.md) — Wire the mixer + relayer + stealth wallet flow end-to-end. The goal: deposit privately, LP from a stealth wallet, withdraw back.
3. [`phase-3-sticky.md`](./phase-3-sticky.md) — The retention and polish work. Rebalance, alerts, mobile, multi-wallet roll-up.

## Status legend

- `[ ]` not started
- `[~]` in progress
- `[x]` done

## Source-of-truth gaps (as of 2026-05-07)

Read [`gaps.md`](./gaps.md) for the inventory of what exists vs. what's stubbed. That file is the *why* behind the checklists.

## Working agreement

- Tick boxes as you go. Don't batch.
- If a task turns out wrong or unnecessary, strike it through and note why — don't silently delete.
- Each phase ends with a "ship gate" — a short list of things that must be true before merging the phase to `main`.
