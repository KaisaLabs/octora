# Octora — Agentic Engineering Grant Application

**Grant**: 200 USDG | **Submit**: https://superteam.fun/earn/grants/agentic-engineering

---

## Step 1: Basics

| Field                  | Value                                                    |
| ---------------------- | -------------------------------------------------------- |
| **Project Title**      | Octora                                                   |
| **One Line Description** | Private execution layer for Meteora LP actions on Solana — shields your wallet from copy-trade bots when adding liquidity. |
| **TG username**        | t.me/theoniomba                                          |
| **Wallet Address**     | 4acVk3daxFFmgU1z9RTmoyKryNhLDVtdCs6ny3jrVt43            |

---

## Step 2: Details

### Project Details

Octora is a privacy-first execution layer for Meteora liquidity provision on Solana. When LPs add liquidity to Meteora pools, their wallet addresses and strategies are fully visible on-chain — making them targets for copy-trade bots that front-run or replicate their positions. Octora solves this by routing LP intents through privacy relays (Vanish + MagicBlock) that decouple the user's origin wallet from pool interactions.

The platform features a complete position lifecycle managed by an 11-state state machine with 7 failure stages and strict transition guards — ensuring no position is ever left in a partial or orphaned state. Users can search Meteora DLMM/DAMM pools, configure strategies, deposit privately, claim rewards, and withdraw through a clean wallet-gated interface.

The backend is built on Fastify 5 with Prisma 7 and PostgreSQL 16, following a modular architecture with clear domain boundaries. The frontend uses React 18 with Vite 5, Tailwind CSS, and shadcn/ui. Privacy adapters and Meteora executors are designed with mock-first seams, allowing clean swap to production providers. The system is fully non-custodial — session wallets are revocable and users maintain full custody at all times.

### Other Fields

| Field                        | Value                                                    |
| ---------------------------- | -------------------------------------------------------- |
| **Deadline**                 | May 15, 2026 (Asia/Calcutta)                             |
| **Personal X Profile**       | x.com/octora_xyz                                         |
| **Personal GitHub Profile**  | github.com/KikoEnakTau                                   |

### Proof of Work

- **GitHub Repository**: https://github.com/KaisaLabs/octora
- **12 commits** covering: modular backend architecture, full Meteora DLMM proxy API (7 endpoints), position lifecycle state machine (11 states, 7 failure stages), Prisma migrations, Scalar interactive API docs, wallet integration, landing page with animations
- **Tech stack shipped**: Fastify 5 REST API, Prisma 7 + PostgreSQL 16, React 18 + Vite 5 frontend, Solana wallet connect (Phantom, Backpack, Solflare)
- **Key endpoints live**: Pool listing, pool detail, position intent creation, position execution, claim rewards, withdraw & close
- **AI-assisted development**: Claude Code + Codex session transcripts attached (proof of agentic engineering workflow)

### Action Items

| Item                         | Instructions                                             |
| ---------------------------- | -------------------------------------------------------- |
| **Colosseum Crowdedness Score** | Visit https://colosseum.com/copilot, screenshot your score, upload to public Google Drive, paste the share link |
| **AI Session Transcript**    | Attach `./claude-session.jsonl` and/or `./codex-session.jsonl` from project root |

---

## Step 3: Milestones

### Goals and Milestones

| #  | Date           | Milestone                                                                 |
| -- | -------------- | ------------------------------------------------------------------------- |
| 1  | May 5, 2026    | Complete vault module with ZK proof-of-deposit circuits (circomlibjs + snarkjs) |
| 2  | May 8, 2026    | Live MagicBlock privacy adapter integration replacing mock adapter        |
| 3  | May 11, 2026   | Live Meteora executor integration with real DLMM SDK transactions on devnet |
| 4  | May 13, 2026   | End-to-end testing: full position lifecycle on devnet with real privacy routing |
| 5  | May 15, 2026   | Devnet deployment with documentation, demo video, and mainnet deployment plan |

### Primary KPI

> Number of private LP positions successfully executed end-to-end on devnet (target: 50+ test positions across 5+ Meteora pools)

### Final Tranche Reminder

To receive the final tranche, submit:
- Colosseum project link
- GitHub repo: https://github.com/KaisaLabs/octora
- AI subscription receipt

---

## Pre-Submission Checklist

- [ ] Session transcripts ready (`./claude-session.jsonl`, `./codex-session.jsonl`)
- [ ] Colosseum Crowdedness Score screenshot uploaded to Google Drive
- [ ] All fields copy-pasted into the form
- [ ] Submit at: https://superteam.fun/earn/grants/agentic-engineering
