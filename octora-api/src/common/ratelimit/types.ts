/**
 * Rate-limiter abstraction. One interface, multiple backends.
 *
 * Two pieces:
 *   - `RateLimiterFactory` — built once at boot from config. Knows the
 *     backend (memory or Redis) but nothing about routes.
 *   - `RateLimiter` — one instance per route family (`/positions/intents`,
 *     `/mixer/withdraw`, …). Holds the window + ceiling and an isolated
 *     bucket namespace so two families with the same caller can't share
 *     each other's quota.
 *
 * The hook in `./fastify-hook.ts` joins these to a Fastify preHandler.
 */
export interface RateLimiterOptions {
  /** Window length, in milliseconds. */
  windowMs: number;
  /** Maximum allowed `consume()` calls per key per window. */
  max: number;
  /**
   * Stable identifier for this limiter's bucket namespace. Used as a key
   * prefix in shared backends (Redis) so independent limiters don't
   * cross-contaminate. Memory backend uses it for symmetry with the
   * Redis path; the in-process Map is already per-instance.
   */
  prefix: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds until the bucket resets, when denied. 0 when allowed. */
  retryAfterMs: number;
}

export interface RateLimiter {
  /**
   * Record one hit against `key`. Returns whether the request is allowed
   * and, when not, how long the caller should back off.
   */
  consume(key: string): Promise<RateLimitDecision>;
}

export interface RateLimiterFactory {
  /** Build a limiter that maintains an independent bucket per `key`. */
  create(options: RateLimiterOptions): RateLimiter;
  /** Release any held resources (timers, sockets). Safe to call twice. */
  close(): Promise<void>;
}
