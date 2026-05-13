/**
 * Public exports for the rate-limit module.
 *
 * Two layers:
 *   - `RateLimiterFactory` — backend (memory or Redis), built once at boot.
 *   - `rateLimitHook(factory, opts)` — Fastify preHandler per route family.
 *
 * The factory is created from `AppConfig.rateLimiter` in `app.ts`. Most
 * callers only see the factory passed through to `registerXxxRoutes`.
 */
export type {
  RateLimiter,
  RateLimiterFactory,
  RateLimiterOptions,
  RateLimitDecision,
} from "./types.js";
export {
  rateLimitHook,
  walletThenIpKey,
  type RateLimitHookOptions,
} from "./fastify-hook.js";
export { createMemoryRateLimiterFactory } from "./memory.js";
export {
  createRedisRateLimiterFactory,
  type RedisRateLimiterOptions,
} from "./redis.js";

import type { AppConfig } from "#common/config";
import type { RateLimiterFactory } from "./types.js";
import { createMemoryRateLimiterFactory } from "./memory.js";
import { createRedisRateLimiterFactory } from "./redis.js";

/**
 * Build the configured rate-limiter factory. Memory by default; Redis
 * when `RATE_LIMITER=redis` and a `REDIS_URL` is set. Throws if the
 * required env vars are missing — a silent fallback to memory would
 * break the multi-replica safety invariant the config promised.
 */
export async function createRateLimiterFactoryFromConfig(
  config: AppConfig,
): Promise<RateLimiterFactory> {
  if (config.rateLimiter.backend === "redis") {
    if (!config.rateLimiter.redisUrl) {
      throw new Error(
        "RATE_LIMITER=redis requires REDIS_URL to be set to a reachable Redis instance.",
      );
    }
    return createRedisRateLimiterFactory({ url: config.rateLimiter.redisUrl });
  }
  return createMemoryRateLimiterFactory();
}
