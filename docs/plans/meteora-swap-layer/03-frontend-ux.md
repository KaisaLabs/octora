# Plan 3 — Frontend UX

**Layer:** `octora-web` — pool browser, intent flow, swap preview, ToS
**Effort:** 2–3 engineer-days
**Depends on:** Plan 2 (backend exposes swap-source recommendation + extended intent body)
**Blocks:** Plan 4 (rollout) only for end-to-end UX validation

## Goal

Surface the swap layer to users without overwhelming them. Default to backend-recommended swap source; allow override; show clear preview. Update ToS so users explicitly accept the new on-chain action.

## Files

### New
- `octora-web/src/components/octora/SwapPreview.tsx`
- `octora-web/src/components/octora/SwapSourceSelector.tsx`
- `octora-web/src/lib/api/swap.ts` — typed client for `GET /pools/:address/swap-source`

### Modify
- `octora-web/src/pages/AppPage.tsx` — intent flow integration
- `octora-web/src/components/octora/PoolSelector.tsx` — drop SOL-only filter
- `octora-web/src/lib/api.ts` — extend `createIntent` body type
- `octora-web/src/lib/tosAck.ts` — bump `CURRENT_TOS_VERSION` and message
- `octora-web/src/components/octora/BetaWarningBanner.tsx` — copy update if needed
- `octora-web/tests/e2e/lp-with-swap.spec.ts` — new Playwright test

## Pool browser

Current behavior: filter pools to SOL-quoted pairs only. New behavior: show every Meteora DLMM pair, but mark pairs without a viable swap source as "unavailable" with tooltip.

```tsx
// PoolSelector.tsx (excerpt)
{pool.quoteSymbol !== "SOL" && !pool.swapSourceAvailable && (
  <Badge variant="muted">no privacy swap path</Badge>
)}
```

`swapSourceAvailable` comes from a backend lookup that resolves the recommended source pool; if null, the pair is shown but disabled.

## Intent flow (per state)

| Step | Pool quote = SOL | Pool quote ≠ SOL |
| ---- | ---------------- | ---------------- |
| 1. Pool selection | Same as today | Same |
| 2. Amount input | "Amount in SOL" | "Amount in SOL" (always SOL — gets swapped) |
| 3. Swap preview | Hidden | **NEW:** `<SwapPreview>` showing source pool, expected out, slippage |
| 4. Confirm | Sign intent | Sign intent (covers both swap + LP) |
| 5. Execution | Funding → LP | Funding → swap → LP |
| 6. Status | Existing states | Existing states + `swap_pending`, `swap_executing`, `swap_indexing` |

## SwapPreview component

```tsx
<SwapPreview
  sourcePool={recommended}        // can be overridden via SwapSourceSelector
  amountIn={solAmount}
  expectedOut={quoteFromBackend}
  slippageBps={50}                // 0.5% default; user-adjustable
  onSlippageChange={setSlippage}
  onSourceChange={setSource}
/>
```

Shows:
- Source pool name + liquidity
- "Swap ~X SOL → ~Y TOKEN"
- Slippage selector: 0.5% (default) / 1% / 2% / custom
- Min received: `expectedOut * (1 - slippage)` — what gets sent on-chain as `minAmountOut`
- Banner: "swap source must differ from LP target — that's how privacy stays intact"

## Validation (client-side)

Before submitting intent:

```ts
if (swapSourceAddress === lpPoolAddress) {
  showError("Swap source pool must differ from LP target. Pick another source.");
  return;
}

if (slippageBps > 500) {
  showError("Slippage above 5% is unsafe. Confirm or reduce.");
  // soft-block with explicit confirm
}
```

Server still re-validates per Plan 2 — this is for UX feedback latency only.

## ToS bump

`tosAck.ts`:

```ts
export const CURRENT_TOS_VERSION = "v2-2026-05-XX"; // pick the date this ships
export const TOS_ACK_MESSAGE = `
By signing, you acknowledge:
- Octora is in BETA and UNAUDITED.
- Your stealth wallet may execute Meteora DLMM swaps as part of LP funding.
  Swap pricing, slippage, and execution risk are your responsibility.
- ...existing terms...
`;
```

Version bump forces all wallets to re-sign on next mutating action. Server-side ack table (per P2-NEW-D in readiness doc) records the new version.

## Status display

Existing position status component renders the new states with copy:

| State | UI label | Sub-text |
| ----- | -------- | -------- |
| `swap_pending` | "Preparing swap" | "Picking the right route..." |
| `swap_executing` | "Swapping" | "Source: <pool name>" |
| `swap_indexing` | "Confirming swap" | "Verifying balances on-chain" |
| `swap_failed` (failure stage) | "Swap failed" | Recovery guidance from catalog |

## Tasks (in order)

1. **API client** (¼ day)
   - `lib/api/swap.ts`: typed wrapper for `GET /pools/:address/swap-source` and extended `POST /positions/intents`.

2. **Components** (1 day)
   - `SwapPreview.tsx` with slippage controls.
   - `SwapSourceSelector.tsx` (modal) for override.

3. **AppPage integration** (½ day)
   - Wire intent flow: detect non-SOL pair → fetch swap source → render preview → include in intent body.

4. **Pool browser update** (¼ day)
   - Drop SOL-only filter. Add "no privacy swap path" badge.

5. **ToS bump** (¼ day)
   - Update version + message. Confirm re-ack flow triggers.

6. **Status display** (¼ day)
   - Add new state labels + sub-text.

7. **Playwright e2e** (¾ day)
   - `lp-with-swap.spec.ts`: full flow on devnet — pick non-SOL pair → preview → submit → poll status to `active`.

## Acceptance

- [ ] Every Meteora DLMM pair selectable; pairs without swap source disabled with tooltip.
- [ ] Swap preview renders for non-SOL pairs with correct expected-out and slippage.
- [ ] Same-pool selection blocked client-side with clear error.
- [ ] ToS modal re-ack triggers on version bump; no double-ack.
- [ ] Status component renders new states.
- [ ] Playwright test passes on devnet.

## Risks

| Risk | Mitigation |
| --- | --- |
| Quote latency (RPC + price calc) makes preview slow | Cache recommended source per (target pool, amount) for 30s; show skeleton |
| User picks unsafe slippage | Soft-block at >5% with explicit confirm; hard-block at >20% |
| Wallet drift mid-flow (user changes wallet between pool select and confirm) | Re-validate on submit; reject with "wallet changed, restart" |
| Mobile UX cramped with extra step | Phase 1 desktop-only; mobile in follow-up |

## Out of scope

- Mobile-optimized swap UX (follow-up)
- Aggregator route comparison (Jupiter — future)
- Custom bin-range UX with swap-aware preview (future)
- Multi-currency display (USD/SOL toggle on swap preview — nice to have)
