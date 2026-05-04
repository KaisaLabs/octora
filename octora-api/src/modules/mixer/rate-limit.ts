import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

/**
 * Minimal in-memory per-IP rate limiter for the mixer routes.
 *
 * This is intentionally tiny — for production, replace with
 * `@fastify/rate-limit` (Redis-backed when running multiple replicas).
 * The fixed-window-counter approach is fine here because the mixer
 * endpoints are low-throughput and a single API replica.
 *
 * Each call to `makeRateLimiter` returns an independent limiter with its
 * own bucket table, so we can have different ceilings per route family
 * (read-heavy vs build-heavy).
 */
export interface RateLimiterOpts {
  /** Window length, in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed per IP per window. */
  max: number;
  /** How often to garbage-collect expired buckets. */
  gcIntervalMs?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export function makeRateLimiter(opts: RateLimiterOpts): preHandlerHookHandler {
  const buckets = new Map<string, Bucket>();
  const gcEvery = opts.gcIntervalMs ?? Math.max(opts.windowMs * 4, 60_000);

  // Periodically prune buckets that have already reset, so the table doesn't
  // grow unbounded under traffic from many distinct IPs.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(ip);
    }
  }, gcEvery);
  // Don't keep the process alive just for the GC.
  if (typeof timer.unref === "function") timer.unref();

  return async (req: FastifyRequest, reply: FastifyReply) => {
    // Fastify's `req.ip` already accounts for trustProxy; fall back to a
    // sentinel so missing IPs all share one bucket rather than dodge limits
    // by missing the field entirely.
    const ip = req.ip || "unknown";
    const now = Date.now();
    const bucket = buckets.get(ip);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(ip, { count: 1, resetAt: now + opts.windowMs });
      return;
    }

    if (bucket.count >= opts.max) {
      const retryAfterMs = bucket.resetAt - now;
      // Standard Retry-After header is in seconds, rounded up so clients
      // don't retry one tick too early.
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
      reply
        .header("Retry-After", String(retryAfterSec))
        .status(429)
        .send({
          error: "Too Many Requests",
          retryAfterMs,
        });
      return reply;
    }

    bucket.count++;
  };
}
