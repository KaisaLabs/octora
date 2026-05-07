# Phase 3 — Sticky

**Goal:** Move from "it works" to "users come back." Active position management, alerts, mobile, deeper analytics.

**Prerequisite:** Phases 1 and 2 ship gates met. There is at least a small base of users actively LPing through Octora.

**Target duration:** Ongoing — pick the highest-leverage items based on real user behavior, not all of them.

---

## 1. Active position management

- [ ] Rebalance / re-range: one-click recenter around active bin (shows preview of new range, fees claimed first)
- [ ] Compound fees: claim and re-deposit into the same range
- [ ] Bulk actions across multiple positions (claim all, close all in pool X)
- [ ] Position templates: save a strategy preset (range width, # bins, distribution) and reuse
- [ ] Auto-rebalance rules (opt-in): "rebalance when out of range for > 24h" — run server-side, user pre-signs

## 2. Alerts & notifications

- [ ] Out-of-range alert (per position, configurable threshold)
- [ ] Claimable-fees threshold alert ("notify when > $X claimable")
- [ ] Volatility alert on watchlist pools
- [ ] Delivery channels: browser push, email, Telegram bot
- [ ] Notification center in-app with read/unread state
- [ ] Per-user notification preferences page

## 3. Discovery & research

- [ ] Sort pools by APR / fee APR / volume / TVL / age
- [ ] Pool comparison view (2–3 pools side by side: APR, IL, volume, fee tier, bin step)
- [ ] Watchlist / starred pools — synced per-wallet
- [ ] IL estimator + volatility score per pool (historical 30-day)
- [ ] "Pools like this" recommendations on pool detail
- [ ] Featured strategies / curated lists (already partially in `featured strats` from recent commits — extend)

## 4. Portfolio depth

- [ ] Time-series PnL: cumulative fees, IL, net PnL over 7d / 30d / all-time
- [ ] Per-pool attribution: which positions made vs. lost
- [ ] CSV export of positions and fee history
- [ ] Tax-friendly export (cost basis, realized vs. unrealized)
- [ ] Multi-wallet roll-up with per-wallet breakdown toggle

## 5. Mobile

- [ ] Responsive pass on every page (Pools, Pool Detail, Portfolio, Position Detail, Activity, Add Liquidity)
- [ ] Mobile wallet adapter (Solana Mobile Stack / WalletConnect for mobile wallets)
- [ ] Touch targets ≥ 44px, no hover-only affordances
- [ ] Bottom nav on mobile, top nav on desktop
- [ ] Real-device QA: iOS Safari, Android Chrome, in-wallet browsers (Phantom, Backpack)

## 6. Trust & polish

- [ ] Onboarding tour for first-time users (Pools → Add Liquidity → Portfolio → Privacy explainer)
- [ ] `/learn` section: what's a bin, what's IL, how DLMM differs from constant-product, how the mixer works
- [ ] Terms of Service + Privacy Policy + Risk Disclaimer (gated checkbox on first deposit)
- [ ] Branded error pages (404, 500, wallet rejected)
- [ ] Empty states with CTAs everywhere — never a generic "Not found"
- [ ] Animation pass: meaningful motion, no excess
- [ ] Accessibility audit: keyboard nav, focus rings, screen reader labels, contrast

## 7. Ops & growth

- [ ] Analytics: PostHog / Plausible — funnel from connect → first add → first claim → second add
- [ ] Public status page (relayer, API, indexer)
- [ ] Public docs site (intro, guides, API reference if applicable)
- [ ] Referral or shared-strategy URLs ("LP this pool with these settings")
- [ ] Announcements / changelog page

---

## Ship gate for Phase 3

There isn't a single ship gate — each section ships independently. Suggested priority order based on retention impact:

1. Out-of-range alerts (#2) — biggest reason LPs disengage
2. Rebalance / re-range (#1) — closes the loop on the alert
3. Mobile responsive (#5) — table stakes once people start sharing
4. Time-series PnL (#4) — makes the product feel real
5. Onboarding + `/learn` (#6) — only matters once you have real top-of-funnel

Do not attempt all of Phase 3 in a sprint. Pick the top one or two based on what users complain about.
