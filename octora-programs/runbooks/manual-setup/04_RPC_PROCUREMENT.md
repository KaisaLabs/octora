# RPC procurement

**Why this matters:** the public Solana RPC endpoint (`api.mainnet-beta.solana.com`) is rate-limited, occasionally degraded, and not designed for production traffic. Octora needs a dedicated provider. The relayer is write-heavy and latency-sensitive (it submits withdraws); the indexer is read-heavy (it reconciles chain state); the frontend needs CDN-cached reads. These should not share an endpoint.

**Closes:** P2-46.

## Provider comparison

| Provider | Strengths | Weaknesses | Pricing rough |
| --- | --- | --- | --- |
| **Helius** | Best-in-class Solana developer experience, enhanced APIs (priority fee endpoint, parsed transactions), webhooks, generous free tier | Premium tier required for serious throughput | Premium ~$500/mo, business ~$1 500/mo |
| **Triton One (Project Serum)** | Bare-metal RPC, very low latency, popular with MEV / arb shops | More expensive, less hand-holding | Custom, ~$1 000+/mo |
| **QuickNode** | Multi-chain, mature dashboards, good failover support | Slightly higher latency than Triton, cost adds up with multiple endpoints | $300–$900/mo for Solana |
| **Alchemy Solana** | Polished UX, good for frontend reads | Solana support newer than EVM; verify their priority-fee handling | $200–$600/mo |

**Recommendation for MVP:** Helius Premium for relayer + indexer (separate API keys), Cloudflare-cached public RPC for the frontend. Add a second provider (Triton or QuickNode) at $300/mo as a hot standby for failover. Total: ~$800–$1 000/mo.

## Endpoint split

| Endpoint | Use | Provider | Latency target | Failover |
| --- | --- | --- | --- | --- |
| `RELAYER_RPC_URL` | Relayer signs and submits withdraw txs | Helius Premium (account A) | < 200 ms p99 | Triton standby |
| `INDEXER_RPC_URL` | Indexer reconciliation, recovery worker | Helius Premium (account B, same plan, separate key for rate-limit isolation) | < 500 ms p99 | Triton standby |
| `FRONTEND_RPC_URL` | Browser ZK prover deposit-list reads, network status check | Cloudflare Workers proxy → Helius free tier | < 1 s acceptable | direct Helius free tier |

Why separate keys for relayer and indexer: if the indexer hammers the endpoint during a reconciliation burst and hits a rate limit, the relayer should not be affected.

## Day-1 actions

Send the following email / form-fill to all three providers (Helius, Triton, QuickNode):

> **Subject:** Production Solana RPC for privacy product (Octora)
>
> We're a privacy product launching closed beta in 3 weeks on Solana mainnet. We need:
>
> 1. Two separate API keys on a paid plan (relayer + indexer separation).
> 2. Sustained ~50 RPS combined, bursts to ~200 RPS during reconciliation.
> 3. Reliable `getRecentPrioritizationFees` and `sendTransaction` with priority fees.
> 4. Account subscription / WebSocket for real-time event streams (DepositEvent / WithdrawEvent on our mixer programs).
> 5. SLA target: 99.9 %, < 200 ms p99 for the relayer-tier endpoint.
>
> Please send: pricing, SLA terms, support channel + on-call contact, and contract turnaround time. Targeting signature within 5 business days.

Get all three quotes in by Day 3. Sign contract by Day 5. Endpoints provisioned in staging by Day 7.

## Cost-saving notes

- Don't pay for an RPC plan that includes archive history. Octora doesn't need archive — just current state + recent slots. Mid-tier plans are usually enough.
- The frontend can use the free tier of any provider behind a Cloudflare Workers cache. Most pool-list reads are highly cacheable (60s TTL is fine).
- During war room launch, you may briefly hit rate limits. Provision 2× expected throughput; downgrade after 2 weeks of beta data.

## Configuration

In Doppler production env:

```
RELAYER_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<RELAYER_KEY>
INDEXER_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<INDEXER_KEY>
RELAYER_RPC_URL_FALLBACK=https://<triton-endpoint>
INDEXER_RPC_URL_FALLBACK=https://<triton-endpoint>

# Frontend (Vite env)
VITE_RPC_URL=https://octora-rpc.workers.dev   # Cloudflare worker → Helius free
VITE_RPC_URL_FALLBACK=https://api.mainnet-beta.solana.com
```

Engineer A wires the failover logic in `octora-api/src/common/solana-tx.ts` — on retryable RPC error, swap to fallback URL for that attempt.

Engineer B wires the frontend fallback in `octora-web/src/lib/solana/config.ts`.

## Cloudflare Workers proxy (for frontend reads)

Optional but recommended. Caches `getMultipleAccounts`, `getAccountInfo`, `getProgramAccounts` for 60 s.

```js
// worker.js
export default {
  async fetch(request, env) {
    const cache = caches.default;
    const cacheKey = new Request(request.url, request);
    let response = await cache.match(cacheKey);
    if (response) return response;

    const upstream = new Request(env.HELIUS_FREE_URL, request);
    response = await fetch(upstream);

    response = new Response(response.body, response);
    response.headers.set('Cache-Control', 'public, max-age=60');
    await cache.put(cacheKey, response.clone());
    return response;
  },
};
```

`env.HELIUS_FREE_URL` is bound in the Cloudflare dashboard to the Helius free-tier endpoint. Cost: free up to 100 k requests/day.

## Health monitoring

The existing `/health` endpoint already calls `getSlot` against the configured RPC with a 2 s timeout. Verify it uses `RELAYER_RPC_URL`. Add a second probe in `/health` that also tests `INDEXER_RPC_URL`:

```ts
const indexerHealthy = await Promise.race([
  indexerConnection.getSlot(),
  new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 2000)),
]).then(() => true).catch(() => false);
```

Surface as `health.indexerRpc: "ok" | "fail"`.

UptimeRobot pings `/health` every 60 s and pages on 2 consecutive failures; that catches both relayer and indexer RPC outages.

## Failover policy

- **Soft fail** (one request fails to relayer endpoint): retry once on fallback, log to Sentry.
- **Hard fail** (5+ failures in 60 s): switch primary to fallback for next 5 min, alert PagerDuty.
- **Sustained outage**: operator decision — pause new deposits via Squads if outage > 30 min.

Document in `runbooks/incident/rpc-degraded.md`.

## Reference

- Helius docs: https://docs.helius.dev/
- Triton One: https://triton.one/
- QuickNode Solana: https://www.quicknode.com/chains/sol
- Existing `octora-api/src/common/config.ts:94–95,157` — current single-endpoint config (engineer A extends this).
