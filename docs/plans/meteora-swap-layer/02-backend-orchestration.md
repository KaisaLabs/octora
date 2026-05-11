# Plan 2 — Backend orchestration

**Layer:** `octora-api` — services, state machine, recovery, persistence
**Effort:** 3–4 engineer-days
**Depends on:** Plan 1 (program instruction available)
**Blocks:** Plan 3 (frontend), Plan 4 (rollout)

## Goal

Insert the swap step between "stealth wallet funded" and "add_liquidity called." Extend the position state machine, validate swap source ≠ LP target, persist swap leg to `Activity`, and have the recovery worker reconcile stuck swaps.

## Files

### New
- `octora-api/src/modules/executor/swap.service.ts`
- `octora-api/src/modules/executor/clients/dlmm-swap.client.ts`
- `octora-api/src/modules/executor/swap-pool-resolver.ts` — picks a non-target Meteora pool to source the token from
- `octora-api/src/modules/executor/__tests__/swap.service.test.ts`

### Modify
- `octora-api/src/domain/state-machine.ts` — new states + transitions
- `octora-api/src/domain/types.ts` — `PositionState` union
- `octora-api/src/domain/recovery-catalog.ts` — recovery guidance for new failure stages
- `octora-api/src/modules/positions/position.service.ts` — orchestrate swap before LP
- `octora-api/src/modules/positions/position.schema.ts` — intent body fields
- `octora-api/src/modules/positions/recovery-worker.ts` — handle stuck swap states
- `octora-api/src/modules/positions/repositories/activity.repository.ts` — `swap_executed` activity kind
- `octora-api/prisma/schema.prisma` — fields on `ExecutionSession`
- `octora-api/src/common/config.ts` — `EXECUTOR_SWAP_ENABLED` feature flag

## State machine extension

Current states (per README): `draft → awaiting_signature → funding_in_progress → executing_on_meteora → indexing → active → claiming|withdrawing|closing → completed | failed`.

New states inserted between `funding_in_progress` and `executing_on_meteora`:

```
funding_in_progress
    │
    ▼
swap_pending             (intent built, awaiting signature/submission)
    │
    ▼
swap_executing           (tx submitted, awaiting confirmation)
    │
    ├── failure ──► failed (stage: swap_failed)
    │
    ▼
swap_indexing            (verify post-swap balances on-chain)
    │
    ▼
executing_on_meteora     (existing — now strictly the LP step)
```

Skip path: when `lpPoolAddress` quote-token == SOL (no swap needed), backend skips the three new states and goes directly from `funding_in_progress` to `executing_on_meteora`. State machine guard validates the skip is legal.

## Intent body changes

`POST /positions/intents` body extension:

```ts
type CreateIntentBody = {
  poolAddress: string;          // existing — LP target pool
  action: "add-liquidity";       // existing
  mode: "standard" | "fast-private";
  amount: number;                // SOL amount user is providing
  walletAddress: string;
  // NEW
  swap?: {
    sourcePoolAddress: string;   // Meteora DLMM pool to swap on
    minAmountOut: string;        // bigint string, slippage-protected
    swapForY: boolean;           // direction
  };
};
```

Validation (in `position.service.ts` before persist):

1. If LP target pool's quote token is SOL → `swap` MUST be absent (or backend can ignore).
2. If LP target pool's quote token ≠ SOL → `swap` MUST be present.
3. **`swap.sourcePoolAddress !== poolAddress`** — hard reject with HTTP 400 `swap_source_equals_target`.
4. Source pool must be a real Meteora DLMM lb_pair (validated via `pools.service` lookup).
5. Source pool must contain SOL on one side AND the target non-SOL token on the other side.
6. `minAmountOut` must be > 0 and ≤ 99% of expected (sanity bound).

## Swap pool resolver (helper)

Backend offers a recommendation when frontend asks "I want to LP on POOL_X, where should I swap from?":

```ts
// swap-pool-resolver.ts
async function recommendSwapSource(targetPool: Pool): Promise<Pool> {
  const targetToken = targetPool.tokenY; // non-SOL side
  const candidates = await pools.findPoolsContaining({ token: targetToken, otherSide: SOL });
  return candidates
    .filter(p => p.address !== targetPool.address)
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
}
```

If no non-target pool exists for the token → return `null`. Frontend shows "no privacy-preserving swap path; this pair is not currently supported."

## Service flow

```ts
// position.service.ts (simplified)
async function executeIntent(intentId: string, signedTx: string) {
  const position = await loadPosition(intentId);

  if (position.swapStep) {
    await transitionTo(position, "swap_pending");
    const swapTx = await swapService.buildAndSubmit(position);
    await transitionTo(position, "swap_executing", { swapTxSig: swapTx.sig });

    const swapResult = await waitForSwap(swapTx.sig); // confirmed commitment
    if (!swapResult.ok) return failPosition(position, "swap_failed", swapResult.reason);

    await transitionTo(position, "swap_indexing");
    await verifyPostSwapBalances(position, swapResult);
  }

  await transitionTo(position, "executing_on_meteora");
  // existing add_liquidity flow
}
```

## Persistence

Add fields to `ExecutionSession` (or a new `SwapLeg` table — I'd keep it on `ExecutionSession` for now):

```prisma
model ExecutionSession {
  // ... existing
  swapPoolAddress  String?
  swapTxSig        String?
  swapAmountIn     BigInt?
  swapMinOut       BigInt?
  swapAmountOut    BigInt?  // populated post-confirm
  swapStartedAt    DateTime?
  swapConfirmedAt  DateTime?
}
```

Activity log row per swap with kind `"swap_executed"`, body `{ poolAddress, amountIn, amountOut, txSig }`. Reuses existing `ActivityRepository`.

## Recovery worker

`recovery-worker.ts` extension:

```ts
// New scan: positions in swap_executing > 5 min
const stuckSwaps = await positions.findInState("swap_executing", { olderThanMs: 5 * 60_000 });
for (const p of stuckSwaps) {
  const sigStatus = await connection.getSignatureStatus(p.swapTxSig);
  if (sigStatus?.confirmationStatus === "confirmed") {
    await transitionTo(p, "swap_indexing");
  } else if (sigStatus === null && (Date.now() - p.swapStartedAt) > 90_000) {
    // tx dropped — fail
    await failPosition(p, "swap_failed", "tx_dropped");
  }
}
```

Captures Sentry exception on any new `swap_failed` per existing pattern.

## Feature flag

`config.ts` reads `EXECUTOR_SWAP_ENABLED` (default `false` until Plan 4 promotes it). When false:

- Pool browser filters out non-SOL-quote pairs.
- Intent endpoint rejects `swap` field with 400.
- State machine refuses to enter `swap_pending`.

This lets the program ship + be deployed without exposing the path until devnet shakedown is complete.

## Tasks (in order)

1. **State machine + types** (½ day)
   - Add new states to `state-machine.ts`. Add transition guards. Run vitest unit tests.
   - Update `recovery-catalog.ts` with new failure stage `swap_failed` (recovery guidance: "swap reverted — check pool liquidity, retry with higher slippage").

2. **Prisma migration** (¼ day)
   - Add new fields to `ExecutionSession`. Create migration. Confirm `prisma migrate dev` clean.

3. **Swap service + DLMM swap client** (1 day)
   - `dlmm-swap.client.ts`: builds `swap_via_dlmm` ix using anchor IDL of executor program. Uses existing `solana-tx.ts` retry helper.
   - `swap.service.ts`: orchestration; pre-flight simulate; submit; poll confirmation.

4. **Pool resolver** (½ day)
   - `swap-pool-resolver.ts`: liquidity-sorted recommendation, with null fallback.
   - Endpoint `GET /pools/:address/swap-source` returns recommended source pool.

5. **Position service wiring** (½ day)
   - Insert swap step before existing `add_liquidity` execution.
   - Validation rules from §"Intent body changes" enforced at controller layer.

6. **Recovery worker** (½ day)
   - Add stuck-swap reconciliation. Test with vitest mocks.

7. **Tests** (1 day)
   - `swap.service.test.ts`: unit tests with mocked Solana RPC.
   - State machine: full lifecycle including swap step.
   - Intent validation: same-pool reject, missing-swap reject for non-SOL pair.

## Acceptance

- [ ] State machine has new states + transitions; all guarded.
- [ ] `POST /positions/intents` with `swap.sourcePoolAddress === poolAddress` returns 400 `swap_source_equals_target`.
- [ ] `POST /positions/intents` for non-SOL pair without `swap` field returns 400.
- [ ] Activity row written with `swap_executed` kind and tx sig.
- [ ] Recovery worker advances `swap_executing` → `swap_indexing` on confirmed sig; fails on dropped tx after 90s.
- [ ] Feature flag `EXECUTOR_SWAP_ENABLED=false` blocks the path end-to-end.

## Risks

| Risk | Mitigation |
| --- | --- |
| Pool resolver returns thin-liquidity pool with bad price | Sort by liquidity USD; reject if liquidity < threshold (e.g. $50k) |
| Swap and LP submitted as separate txs — price moves between them | Phase 2: combine into single tx via cross-program ix or transaction composition with `addInstructions` |
| Recovery worker double-submits on race | Use atomic `updateMany` with `state` precondition (existing pattern) |
| Token-2022 mint with transfer hooks breaks balance reads | Detect via mint inspection; reject swap if hooks present (until tested) |

## Out of scope

- Frontend (Plan 3)
- Symmetric exit swap (covered by P0-NEW-I in readiness doc; uses same `swap_via_dlmm` ix)
- Combined swap + LP in single tx (Phase 2 optimization)
- Multi-hop / Jupiter
