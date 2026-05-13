import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import type { RateLimiterFactory, RateLimiterOptions } from "./types.js";

/**
 * Fastify preHandler that consumes from a rate limiter and replies 429
 * when denied. Caller picks the key extractor — see `walletThenIpKey`
 * for the canonical "authenticated → wallet, unauthenticated → IP" rule.
 *
 * Per-route fields:
 *   - `windowMs` / `max`: ceiling for this route family.
 *   - `prefix`: bucket namespace. Two limiters with the same prefix
 *     share Redis state across replicas — pick a stable string like
 *     `mixer:write` or `positions:mutate`.
 *   - `keyFor`: builds the bucket key from the request. Defaults to
 *     `req.ip`; mutating routes should pass `walletThenIpKey` so a
 *     malicious caller can't dodge by rotating IPs after auth.
 */
export interface RateLimitHookOptions extends RateLimiterOptions {
  keyFor?: (req: FastifyRequest) => string;
}

export function rateLimitHook(
  factory: RateLimiterFactory,
  options: RateLimitHookOptions,
): preHandlerHookHandler {
  const limiter = factory.create(options);
  const keyFor = options.keyFor ?? defaultIpKey;
  return async (req, reply) => {
    const key = keyFor(req) || "unknown";
    const decision = await limiter.consume(key);
    if (!decision.allowed) {
      // Retry-After is in whole seconds, rounded up so clients don't
      // wake one tick too early and see another 429.
      const retryAfterSec = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      reply
        .header("Retry-After", String(retryAfterSec))
        .status(429)
        .send({
          error: "Too Many Requests",
          retryAfterMs: decision.retryAfterMs,
        });
      return reply;
    }
  };
}

function defaultIpKey(req: FastifyRequest): string {
  return req.ip || "unknown";
}

/**
 * Default key for authenticated routes: wallet address when present,
 * otherwise the caller IP. Prefixed so the two namespaces can't collide
 * (a wallet base58 string can't start with `ip:`).
 *
 * Rate limits are about *who* is allowed how much, not *where* they come
 * from. Once we know the caller's wallet, that's the truer identity —
 * a malicious actor rotating IPs after sign-in would otherwise reset
 * their quota with every connection.
 */
export function walletThenIpKey(req: FastifyRequest): string {
  const wallet = req.wallet?.address;
  if (wallet) return `wallet:${wallet}`;
  return `ip:${req.ip || "unknown"}`;
}
