import type { FastifyInstance } from "fastify";
import { PublicKey } from "@solana/web3.js";

import { requireAdminToken } from "#common/auth";
import type { WaitlistRepository } from "#modules/waitlist/waitlist.repository";

export interface AdminRoutesDeps {
  waitlistRepo: WaitlistRepository;
  /** Bearer token from `OCTORA_ADMIN_API_TOKEN`; null disables admin routes. */
  adminApiToken: string | null;
}

/**
 * `/admin/*` routes. Gated by a shared bearer token (`Authorization:
 * Bearer <token>`). When `OCTORA_ADMIN_API_TOKEN` is unset the gate
 * fails closed with 503 — same posture as the relayer when its env vars
 * are missing.
 *
 * Routes:
 *   POST /admin/waitlist/approve   — flip `BetaAccess` on for a wallet
 *   POST /admin/waitlist/revoke    — flip it off
 */
export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: AdminRoutesDeps,
): Promise<void> {
  const tags = ["Admin"];
  const gate = requireAdminToken(deps.adminApiToken);

  await app.register(async (scope) => {
    scope.addHook("onRequest", gate);

    scope.post<{ Body: { walletAddress: string; note?: string } }>(
      "/admin/waitlist/approve",
      {
        schema: {
          tags,
          body: {
            type: "object",
            required: ["walletAddress"],
            properties: {
              walletAddress: { type: "string", minLength: 32 },
              note: { type: "string" },
            },
          },
        },
      },
      async (req, reply) => {
        const { walletAddress, note } = req.body;
        try {
          new PublicKey(walletAddress);
        } catch {
          return reply
            .code(400)
            .send({ error: "BadRequest", message: "walletAddress is not a valid base58 pubkey." });
        }
        const row = await deps.waitlistRepo.approveWallet(walletAddress, note);
        return reply.send({
          walletAddress: row.walletAddress,
          approvedAt: row.approvedAt.toISOString(),
        });
      },
    );

    scope.post<{ Body: { walletAddress: string } }>(
      "/admin/waitlist/revoke",
      {
        schema: {
          tags,
          body: {
            type: "object",
            required: ["walletAddress"],
            properties: { walletAddress: { type: "string", minLength: 32 } },
          },
        },
      },
      async (req, reply) => {
        const removed = await deps.waitlistRepo.revokeWallet(req.body.walletAddress);
        return reply.send({ revoked: removed });
      },
    );
  });
}
