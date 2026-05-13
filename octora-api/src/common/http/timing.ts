import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Per-route HTTP latency histograms (Phase 4 / P1-44).
 *
 * The legacy `/metrics` snapshot exposed point-in-time totals (mixer
 * TVL, position state distribution). Useful for dashboards, useless for
 * spotting a single route degrading. This module adds a Prometheus-style
 * histogram per `{ route, status }` so monitors can alert on p95 drift.
 *
 * Two pieces in one file because they're trivially coupled:
 *   1. {@link createHttpTimingRegistry} — in-memory aggregator. Bounded
 *      cardinality: only routes that Fastify resolved (so unmatched URLs
 *      collapse into `unknown` instead of unique-per-attacker buckets).
 *   2. {@link registerHttpTiming} — Fastify plugin that stamps
 *      `req[START_TIME]` on `onRequest` and records on `onResponse`.
 *
 * Buckets are the standard Prom defaults in ms, suitable for an HTTP
 * API where we care most about p50/p95/p99 in the 10ms–2s range.
 */

const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000] as const;

export type HistogramBucketsMs = typeof BUCKETS_MS;

export interface HttpRouteHistogram {
  route: string;
  method: string;
  status: number;
  /** Total requests observed in this `{route, method, status}` cell. */
  count: number;
  /** Sum of observed durations (ms). Lets monitors compute mean. */
  sumMs: number;
  /** Bucket upper bounds (inclusive), in ms, paired with cumulative counts. */
  buckets: { leMs: number; count: number }[];
}

export interface HttpTimingSnapshot {
  bucketsMs: HistogramBucketsMs;
  routes: HttpRouteHistogram[];
}

export interface HttpTimingRegistry {
  record(input: { route: string; method: string; status: number; durationMs: number }): void;
  snapshot(): HttpTimingSnapshot;
  reset(): void;
}

interface Cell {
  count: number;
  sumMs: number;
  bucketCounts: number[];
}

export function createHttpTimingRegistry(): HttpTimingRegistry {
  const cells = new Map<string, Cell>();

  function cellKey(route: string, method: string, status: number): string {
    return `${method} ${route} ${status}`;
  }

  return {
    record({ route, method, status, durationMs }) {
      const key = cellKey(route, method, status);
      let cell = cells.get(key);
      if (!cell) {
        cell = { count: 0, sumMs: 0, bucketCounts: BUCKETS_MS.map(() => 0) };
        cells.set(key, cell);
      }
      cell.count += 1;
      cell.sumMs += durationMs;
      // Prometheus histograms use cumulative buckets: a sample at 12ms
      // increments every bucket with le >= 12. Lets pre-computed sums
      // answer "share of requests under N ms" without re-scanning.
      for (let i = 0; i < BUCKETS_MS.length; i++) {
        if (durationMs <= BUCKETS_MS[i]!) {
          cell.bucketCounts[i] = (cell.bucketCounts[i] ?? 0) + 1;
        }
      }
    },

    snapshot() {
      const routes: HttpRouteHistogram[] = [];
      for (const [key, cell] of cells.entries()) {
        const [method, route, statusStr] = key.split(" ");
        routes.push({
          route: route!,
          method: method!,
          status: Number(statusStr),
          count: cell.count,
          sumMs: cell.sumMs,
          buckets: BUCKETS_MS.map((leMs, i) => ({
            leMs,
            count: cell.bucketCounts[i] ?? 0,
          })),
        });
      }
      routes.sort((a, b) =>
        a.route === b.route
          ? a.status - b.status
          : a.route.localeCompare(b.route),
      );
      return { bucketsMs: BUCKETS_MS, routes };
    },

    reset() {
      cells.clear();
    },
  };
}

const START_TIME = Symbol("octora.httpTiming.startNs");

interface TimedRequest extends FastifyRequest {
  [START_TIME]?: bigint;
}

/**
 * Register the `onRequest` / `onResponse` hooks that feed the registry.
 *
 * The route label prefers `req.routeOptions.url` (Fastify's matched
 * pattern, e.g. `/positions/:positionId`) so high-cardinality params
 * don't explode the cell count. Falls back to `unknown` when no route
 * matched (404s, malformed URLs).
 */
export function registerHttpTiming(app: FastifyInstance, registry: HttpTimingRegistry): void {
  app.addHook("onRequest", async (req: TimedRequest) => {
    req[START_TIME] = process.hrtime.bigint();
  });

  app.addHook("onResponse", async (req: TimedRequest, reply: FastifyReply) => {
    const start = req[START_TIME];
    if (start === undefined) return;
    const elapsedNs = process.hrtime.bigint() - start;
    const durationMs = Number(elapsedNs) / 1_000_000;
    const route = req.routeOptions?.url ?? "unknown";
    const method = req.method;
    registry.record({
      route,
      method,
      status: reply.statusCode,
      durationMs,
    });
  });
}
