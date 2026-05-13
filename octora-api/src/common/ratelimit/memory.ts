import type {
  RateLimitDecision,
  RateLimiter,
  RateLimiterFactory,
  RateLimiterOptions,
} from "./types.js";

/**
 * In-process memory rate limiter. Fixed-window-counter per key.
 *
 * Same semantics as the previous `mixer/rate-limit.ts`: each key's bucket
 * carries a count + reset timestamp; expired buckets are GC'd to keep
 * the table bounded under churn from many distinct callers.
 *
 * Process-local — does NOT survive across replicas. For multi-instance
 * deployments use `createRedisRateLimiterFactory` instead.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const DEFAULT_GC_INTERVAL_MS = 60_000;

export function createMemoryRateLimiterFactory(): RateLimiterFactory {
  const timers: NodeJS.Timeout[] = [];

  function build(options: RateLimiterOptions): RateLimiter {
    const buckets = new Map<string, Bucket>();
    const gcEvery = Math.max(options.windowMs * 4, DEFAULT_GC_INTERVAL_MS);
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [k, b] of buckets) {
        if (b.resetAt <= now) buckets.delete(k);
      }
    }, gcEvery);
    if (typeof timer.unref === "function") timer.unref();
    timers.push(timer);

    return {
      async consume(key: string): Promise<RateLimitDecision> {
        const now = Date.now();
        const bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
          buckets.set(key, { count: 1, resetAt: now + options.windowMs });
          return { allowed: true, retryAfterMs: 0 };
        }
        if (bucket.count >= options.max) {
          return { allowed: false, retryAfterMs: bucket.resetAt - now };
        }
        bucket.count++;
        return { allowed: true, retryAfterMs: 0 };
      },
    };
  }

  return {
    create: build,
    async close() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
  };
}
