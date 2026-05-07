# Phase 1 — It Actually Works

**Goal:** A user connects a wallet, opens a real LP position on a Meteora DLMM pool, sees it in the portfolio, claims fees, and closes the position. **No mixer, no stealth wallet, no relayer.** Pure non-private path so we can validate the full plumbing first.

**Why this phase first:** Privacy is the differentiator, but it's worthless if the underlying portfolio manager doesn't work. Ship the boring core, then layer privacy on top.

**Target duration:** 2–3 weeks of focused work.

---

## 1. Add Liquidity flow (the biggest single gap)

- [ ] Create `octora-web/src/pages/AddLiquidityPage.tsx` and route (`/pool/:address/add` or modal off pool detail)
- [ ] Strategy selector: Spot / Curve / Bid-Ask with a small visual diagram for each
- [ ] Range picker — min price, max price, # of bins, "lock to active bin" toggle
- [ ] Live bin preview chart that updates as the user drags the range
- [ ] Amount inputs for both tokens with auto-balance (changing one updates the other based on chosen strategy)
- [ ] Max button + USD equivalent + wallet balance display
- [ ] Wrap SOL handling (when user picks SOL on a wSOL pool)
- [ ] Slippage tolerance setting (0.1 / 0.5 / 1.0 / custom)
- [ ] Confirm modal: bins, deposit ratio, est. daily fees, est. priority fee, total
- [ ] Submit button calls `POST /positions/intents` then `POST /positions/:id/execute`
- [ ] Progress UI driven by the backend's 11-state machine (signing → funding → executing → indexing → active)
- [ ] Failure UI surfaces the recovery guidance the backend already returns

## 2. Real on-chain execution (replace mocks)

- [ ] Implement DLMM CPI handlers in `programs/octora-executor/`:
  - [ ] `dlmm_init_position`
  - [ ] `dlmm_add_liquidity`
  - [ ] `dlmm_claim_fees`
  - [ ] `dlmm_withdraw_close`
- [ ] Wire `OnchainMeteoraExecutor` to call those CPIs, not just build dummy txs
- [ ] Default `OCTORA_USE_ONCHAIN_EXECUTOR=true` in dev/staging configs
- [ ] Real signing flow: backend returns unsigned tx → frontend signs with connected wallet → submits
- [ ] `simulateTransaction` before submit; show errors clearly
- [ ] Compute-budget tuning + priority-fee picker (low / medium / high), persist last choice

## 3. Real portfolio (delete the mock data)

- [ ] Delete or quarantine `octora-web/src/data/octora.ts` so it can't accidentally render in prod
- [ ] Build position indexer that feeds `PositionReconciliation` from on-chain state
- [ ] `GET /positions?owner=<pubkey>` returns the user's real DLMM positions
- [ ] `PortfolioPage.tsx` fetches via TanStack Query keyed on connected wallet(s)
- [ ] Multi-wallet roll-up: aggregate stats across all selected wallets
- [ ] Per-position live values: current value, fees earned, IL, in-range badge
- [ ] Empty state with CTA → Pools (browse) → Add Liquidity
- [ ] Loading skeleton (no layout jump on first paint)

## 4. Position actions (wire the buttons)

- [ ] Claim fees handler in `PositionCard.tsx` → `POST /positions/:id/claim` → tx submit → toast on success/failure
- [ ] Withdraw partial: slider for % (0–100), preview tokens out
- [ ] Withdraw + close: confirms full exit, returns rent
- [ ] All three actions update local query cache optimistically and reconcile from indexer
- [ ] Error toasts surface the backend's recovery guidance, not raw errors

## 5. Foundations: errors, loading, network

- [ ] Toast/notification system (sonner or shadcn equivalent) — adopted globally
- [ ] React error boundary at the route level with a recovery action
- [ ] Loading skeletons on Pools, Pool Detail, Portfolio, Position Detail
- [ ] Network guard: warn / block when wallet is on the wrong cluster
- [ ] Mainnet vs devnet toggle visible in header (defaults to mainnet for prod build)

## 6. Mainnet config

- [ ] Env files per cluster: `.env.devnet`, `.env.mainnet`, `.env.local`
- [ ] Mainnet RPC behind a paid provider (Helius / Triton), not public RPC
- [ ] Backend secrets via env (no hardcoded keypair paths in prod)
- [ ] Deploy pipeline: web → Vercel/Netlify, API → Railway/Fly, DB → managed Postgres
- [ ] Health check endpoint + uptime monitor
- [ ] Sentry (or equivalent) wired on web + api

---

## Ship gate for Phase 1

All of these must be true before declaring Phase 1 done:

- [ ] A first-time user on mainnet can: connect → pick a pool → add liquidity → see the position → claim fees → close → return to empty portfolio
- [ ] No mock data renders in a production build (`vite build` + grep)
- [ ] `OCTORA_USE_ONCHAIN_EXECUTOR=true` is the default everywhere
- [ ] All mutations show success/error toasts; nothing fails silently
- [ ] Sentry has < 1% error rate over a 24-hour soak
- [ ] At least one external user (not the team) successfully completes the flow on mainnet
