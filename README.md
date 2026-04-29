<p align="center">
  <h1 align="center">Octora</h1>
  <p align="center"><em>Private execution layer for Meteora LP actions on Solana</em></p>
</p>

---

Octora shields your origin wallet when you add liquidity to Meteora pools — copy-trade bots see nothing. Search pools, configure strategies, deposit privately, and claim rewards through a clean, wallet-gated interface. Behind the scenes, intents are routed through privacy relays (Vanish + MagicBlock) that decouple your identity from pool visibility.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  octora-web (React + Vite)                              │
│  Landing page · Pool browser · Strategy setup · Wallet  │
└──────────────────┬──────────────────────────────────────┘
                   │ HTTP (REST)
┌──────────────────▼──────────────────────────────────────┐
│  octora-api (Fastify + Prisma)                          │
│  Pool proxy · Position orchestrator · State machine     │
│  Privacy adapters (Mock / MagicBlock) · Indexer         │
└──────┬──────────────────────┬───────────────────────────┘
       │                      │
┌──────▼──────┐    ┌──────────▼──────────┐
│  Meteora    │    │  PostgreSQL 16      │
│  DLMM/DAMM  │    │  Positions · Sessions│
│  API        │    │  Activity · Recovery  │
└─────────────┘    └─────────────────────┘
```

### Position lifecycle state machine

```
draft → awaiting_signature → funding_in_progress → executing_on_meteora
                                                         │
                                                    indexing → active
                                                         │
                                          ┌──────────────┼──────────────┐
                                          ▼              ▼              ▼
                                      claiming      withdrawing      closing
                                          │              │              │
                                          ▼              ▼              ▼
                                      completed      completed      completed
                                          │
                                    (on failure) → failed
```

**11 states · 7 failure stages · Strict transition guard** — every position move is validated by the state machine. Recovery guidance is provided per failure stage.

## Project structure

```
octora/
├── octora-web/          # Frontend (React 18, Vite 5, Tailwind 3)
│   ├── src/
│   │   ├── pages/           # Index (landing), AppPage (dashboard)
│   │   ├── components/
│   │   │   ├── octora/      # Platform UI (tables, cards, hero, header)
│   │   │   ├── landing/     # Animation components (ScrollReveal, LogoMarquee)
│   │   │   └── ui/          # 49 shadcn/ui components
│   │   ├── lib/             # API client, Solana client
│   │   ├── providers/       # SolanaProvider (wallet connect + balance)
│   │   └── data/            # Static demo data
│   └── ...
├── octora-api/           # Backend (Fastify 5, Prisma 7, PostgreSQL)
│   ├── src/
│   │   ├── modules/
│   │   │   ├── pools/       # GET /pools, GET /pools/:address
│   │   │   └── positions/   # Full position lifecycle CRUD
│   │   ├── domain/          # Types, state machine, policies, recovery
│   │   ├── adapters/        # PrivacyAdapter (Mock + MagicBlock seam)
│   │   ├── clients/         # MeteoraExecutor (Mock + live)
│   │   ├── indexer/         # On-chain reconciliation
│   │   ├── runtime/         # PodRuntime abstraction
│   │   └── test-kit/        # Shared test factories
│   ├── prisma/              # Schema: Position, ExecutionSession, Activity, Reconciliation
│   └── infra/               # Docker Compose (PostgreSQL 16)
├── octora-waitlist/      # Standalone cinematic coming-soon page
├── plans/                # Implementation plans + demo checklists
├── specs/                # Product spec + system design
└── briefs/               # Design briefs
```

## Tech stack

| Layer         | Technology                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| **Frontend**      | React 18 · Vite 5 · Tailwind CSS 3 · shadcn/ui · React Router 6 · TanStack Query · framer-motion · GSAP |
| **Solana**        | @solana/kit · @solana/client · @solana/react-hooks · wallet-standard                                        |
| **Backend**       | Fastify 5 · TypeScript 5.8 · tsx                                                                           |
| **Database**      | PostgreSQL 16 · Prisma 7                                                                                   |
| **Oracles/DeFi**  | Meteora DLMM SDK · @meteora-ag/dlmm                                                                        |
| **Testing**       | Vitest · Playwright · LiteSVM/Mollusk                                                                       |
| **Infrastructure**| Docker Compose · pnpm                                                                                      |

## Getting started

### Prerequisites
- **Node.js** ≥ 20
- **pnpm** ≥ 10 (for the API)
- **npm** or **bun** (for the web frontend)
- **Docker** (for PostgreSQL)

### 1. Start the database
```bash
cd octora-api
docker compose -f infra/docker-compose.dev.yml up -d
```

### 2. Set up environment variables
```bash
# octora-api/.env
cp octora-api/.env.example octora-api/.env
# Edit DATABASE_URL, Solana RPC URLs if needed

# octora-web/.env
cp octora-web/.env.example octora-web/.env
# Set VITE_API_URL=http://localhost:8787
```

### 3. Install dependencies
```bash
# Backend
cd octora-api && pnpm install

# Frontend
cd octora-web && npm install
```

### 4. Run database migrations & seed demo data
```bash
cd octora-api
pnpm prisma migrate dev
pnpm seed:demo
```

### 5. Start the dev servers
```bash
# Terminal 1 — API (port 8787)
cd octora-api && pnpm dev

# Terminal 2 — Web (port 3000)
cd octora-web && npm run dev
```

Open **http://localhost:3000** for the landing page, **http://localhost:3000/app** for the dashboard.

## API reference

The backend exposes a REST API at `http://localhost:8787`.

| Method | Endpoint                            | Description            |
| ------ | ----------------------------------- | ---------------------- |
| `GET`    | `/health`                             | Health check           |
| `GET`    | `/pools`                              | List Meteora pools     |
| `GET`    | `/pools/:address`                     | Get pool detail        |
| `POST`   | `/positions/intents`                  | Create position intent |
| `GET`    | `/positions/:positionId`              | Get position + activity |
| `POST`   | `/positions/:positionId/execute`      | Execute signed intent  |
| `POST`   | `/positions/:positionId/claim`        | Claim rewards          |
| `POST`   | `/positions/:positionId/withdraw-close` | Withdraw & close     |

### Example: list pools
```bash
curl http://localhost:8787/pools?network=mainnet&limit=10
```

### Example: create a position intent
```bash
curl -X POST http://localhost:8787/positions/intents \
  -H "Content-Type: application/json" \
  -d '{
    "poolAddress": "8vQ5Qp6V...DLMM",
    "action": "add-liquidity",
    "mode": "standard",
    "amount": 5000,
    "walletAddress": "9HhS...k3WQ"
  }'
```

## Execution modes

| Mode             | Description                                                              | TTL   | Recovery    |
| ---------------- | ------------------------------------------------------------------------ | ----- | ----------- |
| **Standard**         | Full privacy — origin wallet never touches Meteora                       | 10m   | Manual      |
| **Fast Private**     | Accelerated execution with fallback to standard on timeout               | 15m   | Auto-retry  |

## Design decisions

- **Privacy-first**: Main wallet stays shielded. Session keys + relay routing (Vanish → MagicBlock → Meteora).
- **State machine**: Every position moves through 11 well-defined states with strict transition guards. No partial execution.
- **Recovery-first**: 7 failure stages, each with guided recovery steps (wait/retry/refresh/contact-support). Positions are never orphaned.
- **Mock-first**: Privacy adapters and Meteora executors are mock-implemented in the MVP with clearly defined seams for production providers.
- **Non-custodial**: Session wallets are revocable. Users keep full custody of funds.

## Testing

```bash
# Backend unit tests
cd octora-api && pnpm test

# Frontend unit tests
cd octora-web && npm test

# Frontend E2E tests
cd octora-web && npm run test:e2e
```

## Roadmap

- [x] Core position lifecycle (draft → active → completed)
- [x] Mock privacy adapter (Vanish + MagicBlock seams)
- [x] Meteora pool proxy (DLMM/DAMM pool listing)
- [x] Wallet connection (Phantom, Backpack, Solflare)
- [x] Landing page with animations
- [ ] Live MagicBlock adapter integration
- [ ] Live Meteora executor integration
- [ ] Indexer with real-time on-chain reconciliation
- [ ] Mainnet deployment
- [ ] Mobile responsive trade flows

## License

MIT
