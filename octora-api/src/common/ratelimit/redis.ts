import type {
  RateLimitDecision,
  RateLimiter,
  RateLimiterFactory,
  RateLimiterOptions,
} from "./types.js";

/**
 * Redis-backed rate limiter.
 *
 * The bucket per (prefix, key) is a single string holding the counter,
 * EXPIRE-driven, mutated atomically by a Lua script so two replicas
 * checking the same caller can't both fall under the ceiling and both
 * admit. Lua runs server-side which means no GET/SET race window.
 *
 * Fixed-window semantics match the in-memory limiter — adopting a
 * sliding window would be a behaviour change, not a Phase-3 P0 goal.
 *
 * `ioredis` is dynamic-imported so the dependency is only pulled when
 * `RATE_LIMITER=redis`; dev environments stay slim and tests don't
 * accidentally open sockets.
 */
const CONSUME_SCRIPT = `
local key       = KEYS[1]
local max       = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])

local count = tonumber(redis.call('INCR', key))
if count == 1 then
  redis.call('PEXPIRE', key, window_ms)
end

local pttl = tonumber(redis.call('PTTL', key))
-- PTTL returns -1 (no expiry) or -2 (no key) under races; treat as full window.
if pttl == nil or pttl < 0 then pttl = window_ms end

if count > max then
  return { 0, pttl }
end
return { 1, 0 }
`;

export interface RedisRateLimiterOptions {
  /** Full Redis URL — `redis://`, `rediss://`, `unix:`. */
  url: string;
  /**
   * Global key namespace. Prevents collisions when one Redis instance
   * backs multiple Octora environments. Defaults to `octora:rl`.
   */
  keyPrefix?: string;
}

interface RedisLikeClient {
  defineCommand(
    name: string,
    opts: { numberOfKeys: number; lua: string },
  ): void;
  quit(): Promise<unknown>;
  // The dynamically-defined consume command — typed loosely because
  // ioredis adds it at runtime.
  rateLimitConsume(key: string, max: number, windowMs: number): Promise<[number, number]>;
}

export async function createRedisRateLimiterFactory(
  options: RedisRateLimiterOptions,
): Promise<RateLimiterFactory> {
  // Dynamic import so `ioredis` is only loaded when actually selected.
  // Other deployments (Vercel preview, local dev) never pay for it.
  // The constructor accepts a URL string overload (plus optional
  // options); the `as unknown` hop is needed because ioredis's
  // declared signatures are union-typed across many overloads.
  const ioredisModule = await import("ioredis");
  const Redis = ioredisModule.default as unknown as new (url: string) => RedisLikeClient;
  const client = new Redis(options.url);
  client.defineCommand("rateLimitConsume", {
    numberOfKeys: 1,
    lua: CONSUME_SCRIPT,
  });

  const globalPrefix = options.keyPrefix ?? "octora:rl";

  function build(routeOptions: RateLimiterOptions): RateLimiter {
    const namespace = `${globalPrefix}:${routeOptions.prefix}`;
    return {
      async consume(key: string): Promise<RateLimitDecision> {
        const composite = `${namespace}:${key}`;
        const [allowed, retryAfterMs] = await client.rateLimitConsume(
          composite,
          routeOptions.max,
          routeOptions.windowMs,
        );
        return { allowed: allowed === 1, retryAfterMs };
      },
    };
  }

  return {
    create: build,
    async close() {
      await client.quit();
    },
  };
}
