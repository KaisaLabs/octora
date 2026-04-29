# Octora

Octora is a private execution layer for Meteora LP actions on Solana.

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
