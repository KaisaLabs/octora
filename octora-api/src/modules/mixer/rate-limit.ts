import type { preHandlerHookHandler } from "fastify";

import {
  createMemoryRateLimiterFactory,
  rateLimitHook,
} from "#common/ratelimit";

/**
 * @deprecated Use `rateLimitHook(factory, opts)` from `#common/ratelimit`
 * with the boot-time `RateLimiterFactory` passed through `app.ts`.
 *
 * This shim is kept so the rate-limit test exercising the standalone
 * memory limiter (`__tests__/rate-limit.test.ts`) still runs. New
 * route wiring should plumb the shared factory.
 *
 * Each call here builds its own private memory factory — independent
 * buckets, no cross-talk — which matches the original semantics.
 */
export interface RateLimiterOpts {
  windowMs: number;
  max: number;
  /** Retained for API parity. The shim builds a fresh factory per call, so
   * pruning is driven by the underlying memory limiter's internal timer. */
  gcIntervalMs?: number;
}

let shimCounter = 0;

export function makeRateLimiter(opts: RateLimiterOpts): preHandlerHookHandler {
  const factory = createMemoryRateLimiterFactory();
  return rateLimitHook(factory, {
    windowMs: opts.windowMs,
    max: opts.max,
    prefix: `legacy:${++shimCounter}`,
  });
}
