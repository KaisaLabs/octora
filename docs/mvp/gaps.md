# Octora — Current State vs. DLMM Platform MVP

Snapshot taken 2026-05-07. Refresh when phases ship.

Legend: ✅ done · 🟡 partial / stubbed · ❌ missing

## What works today

- ✅ Wallet connect (Phantom / Backpack / Solflare via Wallet Standard)
- ✅ Multi-wallet picker (`AppShell.tsx`)
- ✅ Pool list + search/filter — `octora-web/src/pages/PoolsPage.tsx`
- ✅ Pool detail page with bin chart + OHLCV — `PoolDetailPage.tsx`, `BinLiquidityChart.tsx`
- ✅ Live USD prices via Jupiter v3, 5s cache — `octora-api` `/prices`
- ✅ Meteora pool/bin proxy endpoints — `octora-api` `/dlmm/*`
- ✅ `octora-mixer` Anchor program: deposit / withdraw / on-chain Groth16 verifier / Merkle tree / nullifier registry
- ✅ Position state machine in backend (11 states + 7 failure-stage recovery guidance)

## What's stubbed

- 🟡 Portfolio page — reads hardcoded mock from `octora-web/src/data/octora.ts`
- 🟡 Position detail — scaffolded but driven by mock data
- 🟡 PnL calendar + breakdown — derived deterministically from a seed, not real fees
- 🟡 Activity page — demo data only
- 🟡 `octora-executor` program — DLMM/DAMM instruction skeletons, CPI handlers not implemented
- 🟡 Backend executor — `MockMeteoraExecutor` is the default; `OnchainMeteoraExecutor` exists behind `OCTORA_USE_ONCHAIN_EXECUTOR` flag but isn't end-to-end
- 🟡 Privacy adapters — `MockPrivacyAdapter` returns deterministic fake receipts; `RelayerAdapter` and `MagicblockAdapter` throw "not live"
- 🟡 Mixer test page (`/mixer-test`) and integrated test page (`/integrated-test`) exist but are dev-only

## What's missing

- ❌ `AddLiquidityPage` — no UI for the most important user flow
- ❌ Strategy selector (Spot / Curve / Bid-Ask) with bin preview
- ❌ Range picker, amount input with auto-balance, slippage preview, confirm modal
- ❌ Claim fees handler (button exists, no API call)
- ❌ Withdraw partial / withdraw + close UI
- ❌ Rebalance / re-range
- ❌ Compound fees
- ❌ Real position indexer feeding `PositionReconciliation`
- ❌ Real activity feed from DB
- ❌ Out-of-range / claimable alerts
- ❌ Notifications (email / Telegram / push)
- ❌ Sort by APR / fee APR / volume / TVL
- ❌ Pool comparison view, watchlist
- ❌ IL / volatility estimator
- ❌ Network guard (block when on wrong cluster)
- ❌ Mainnet config pipeline (RPC, secrets, env-per-cluster)
- ❌ Error boundaries + toast on every mutation
- ❌ Mobile responsive pass
- ❌ Onboarding / first-run tour, privacy explainer
- ❌ Terms / risk disclaimer
- ❌ Analytics + error reporting (Sentry / PostHog)
- ❌ Rate limit / abuse protection on public API

## Key file paths

| Area | Path | Note |
|---|---|---|
| Add Liquidity (missing) | `octora-web/src/pages/` | New page needed |
| Portfolio fetch | `octora-web/src/pages/PortfolioPage.tsx` | Currently uses `portfolioPositions` prop, not API |
| Position card actions | `octora-web/src/components/PositionCard.tsx` | Claim button has no handler |
| Executor handlers | `octora-api/src/modules/executor/executor.service.ts` | Skeleton |
| Relayer adapter | `octora-api/src/modules/execution/adapters/relayer.adapter.ts` | Throws "not live" |
| Demo data | `octora-web/src/data/octora.ts` | Three hardcoded LP positions |
| On-chain executor | `programs/octora-executor/` | DLMM/DAMM instructions present, handlers TODO |
| Mixer program | `programs/octora-mixer/` | Functional |
