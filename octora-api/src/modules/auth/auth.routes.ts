import type { FastifyInstance } from "fastify";

import { issueAuthNonce } from "#common/auth";
import { makeRateLimiter } from "#modules/mixer/rate-limit";

import type { AuthRepository } from "./auth.repository.js";

export interface AuthRoutesDeps {
  authRepo: AuthRepository;
}

/**
 * `/auth/nonce` — issues a one-time challenge for the
 * `requireWalletSignature` preHandler. The wallet signs the returned nonce
 * string (UTF-8 bytes) and presents the signature on the next mutating
 * call as `x-signature`.
 *
 * Rate-limited per IP because each issued nonce takes a row in
 * `AuthNonce` and a malicious caller could otherwise flood the table.
 */
export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRoutesDeps,
): Promise<void> {
  const limiter = makeRateLimiter({ windowMs: 60_000, max: 30 });

  await app.register(async (scope) => {
    scope.addHook("onRequest", limiter);
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
