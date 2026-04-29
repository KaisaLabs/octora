# Octora

Octora is a standalone execution layer for Meteora LP actions on Solana.

## Project Artifacts

- Spec: `specs/2026-04-29-octora-core-privacy-execution-design.md`
- Brief: `briefs/2026-04-29-octora-pm-bd-one-pager.md`
- Implementation plan: `plans/2026-04-29-octora-core-privacy-execution-implementation-plan.md`
- Demo walkthrough checklist: `plans/2026-04-29-octora-demo-walkthrough-checklist.md`

## Micro-Repo Structure

This repository is split into two independent projects:

### `octora-web/` — Frontend
- React + Vite + Tailwind app
- Wallet-gated UX, pool search, strategy setup, deposit/claim/withdraw-close lifecycle
- Run: `cd octora-web && pnpm dev` (port 3000)

### `octora-api/` — Backend
- Fastify + Prisma + internal pnpm workspace
- Orchestrator API, shared packages (domain, indexer, adapters, runtime, test-kit)
- Run: `cd octora-api && pnpm dev` (API dev server)
- Infra: `cd octora-api && docker compose -f infra/docker-compose.dev.yml up -d`

## Current Scope

- Standalone web app
- SOL-first add liquidity
- Claim
- Withdraw and close
- Standard and Fast Private modes
- Internal privacy adapter seam

## Privacy Framing

- Honest claim: Octora makes LP activity harder to follow from a main wallet.
- Non-claim: it does not make activity invisible.
- Non-claim: it does not promise perfect anonymity.
- Non-claim: it does not claim generalized private trading across Solana.

## Demo And Walkthrough

- Demo seed script: `octora-api/services/orchestrator-api/src/scripts/seed-demo-data.ts`
- Demo seed panel: `octora-web/src/features/positions/components/demo-seed-panel.tsx`

## Repo Note

- `octora-waitlist/` remains untouched and separate from the product app.
