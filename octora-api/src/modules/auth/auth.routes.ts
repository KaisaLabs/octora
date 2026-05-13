import type { FastifyInstance } from "fastify";

import { issueAuthNonce } from "#common/auth";
import { rateLimitHook, type RateLimiterFactory } from "#common/ratelimit";

import type { AuthRepository } from "./auth.repository.js";

export interface AuthRoutesDeps {
  authRepo: AuthRepository;
  rateLimiterFactory: RateLimiterFactory;
}

/**
 * `/auth/nonce` — issues a one-time challenge for the
 * `requireWalletSignature` preHandler. The wallet signs the returned nonce
 * string (UTF-8 bytes) and presents the signature on the next mutating
 * call as `x-signature`.
 *
 * Rate-limited by `{walletAddress, ip}` — the request body itself declares
 * which wallet is asking, so use that as the primary bucket key. Without
 * it, an attacker rotating wallet addresses could flood the `AuthNonce`
 * table from one IP, or a coordinated multi-IP attack could exhaust a
 * single wallet's quota.
 */
export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRoutesDeps,
): Promise<void> {
  const limiter = rateLimitHook(deps.rateLimiterFactory, {
    windowMs: 60_000,
    max: 30,
    prefix: "auth:nonce",
    keyFor: (req) => {
      const body = (req.body ?? {}) as { walletAddress?: unknown };
      const wallet = typeof body.walletAddress === "string" ? body.walletAddress : null;
      if (wallet) return `wallet:${wallet}`;
      return `ip:${req.ip || "unknown"}`;
    },
  });

  await app.register(async (scope) => {
    scope.addHook("preHandler", limiter);
    scope.post<{ Body: { walletAddress: string } }>(
      "/auth/nonce",
      {
        schema: {
          tags: ["Auth"],
          body: {
            type: "object",
            required: ["walletAddress"],
            properties: { walletAddress: { type: "string", minLength: 32 } },
          },
        },
      },
      async (req, reply) => {
        const { walletAddress } = req.body;
        try {
          const issued = await issueAuthNonce(deps.authRepo, walletAddress);
          return reply.send({
            nonce: issued.nonce,
            expiresAt: issued.expiresAt.toISOString(),
          });
        } catch (err) {
          const sc = (err as { statusCode?: unknown })?.statusCode;
          const status = typeof sc === "number" ? sc : 500;
          return reply.code(status).send({
            error: "BadRequest",
            message: err instanceof Error ? err.message : "Failed to issue nonce.",
          });
        }
      },
    );
  });
}
