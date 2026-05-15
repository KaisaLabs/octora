# Context Map

Octora is a private execution layer for Meteora LP actions on Solana. Three contexts collaborate through three privacy flows.

## Contexts

- [On-Chain Privacy & Execution](./programs/CONTEXT.md) — Anchor programs: `octora-mixer` (ZK SOL pool) and `octora-executor` (admin-gated DLMM CPI proxy)
- [Backend Orchestration](./octora-api/CONTEXT.md) — Fastify service. Owns the Position lifecycle, drives the three privacy flows, and reconciles on-chain state
- [Web Client](./octora-web/CONTEXT.md) — React UI. Wallet-gated, presents Positions and runs the user-side cryptography (Encrypted Seed)

## The three privacy flows

1. **Private Deposit** — origin wallet → `octora-mixer` (Commitment lands in the Merkle Tree)
2. **Private Position Open** — mixer withdraw → **Stealth Wallet** → `octora-executor` → Meteora **DLMM Position**
3. **Private Position Close** — DLMM exit → Stealth Wallet (may hold the non-SOL side of the pair) → Meteora swap back to SOL → re-mix to fresh recipient

## Relationships

- **Web → API**: HTTP REST. Web initiates each privacy flow against a single Position.
- **API → On-Chain**: API signs and submits transactions through the relayer. Owns the off-chain orchestration: state machine, Mode Fallback, Recovery Guidance.
- **Mixer ↔ Executor**: No direct CPI link. Glued by API orchestration — a Stealth Wallet is funded by a mixer withdraw, then becomes the owner of an Executor-built DLMM Position.

## Cross-context shared terms

- **Stealth Wallet**, **DLMM Position**, **Denomination**, **Anonymity Set**, **Commitment**, **Nullifier Hash** appear in multiple contexts. Definitions live in the on-chain glossary; other contexts reuse them verbatim.
