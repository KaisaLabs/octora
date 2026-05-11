import type { FastifyReply, FastifyRequest } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { randomUUID } from "node:crypto";
import type { PrivacyAdapter, PrivacyReceipt } from "#modules/execution/adapters";

export interface PreparePrivateDepositBody {
  poolAddress: string;
  stealthPubkey: string;
  shape: "spot" | "curve" | "bid-ask";
  range: { lower: number; upper: number };
  /** Optional — when omitted, falls back to the first configured denomination. */
  denominationLamports?: string;
  /**
   * Optional client-generated positionId. The browser orchestrator
   * generates a UUID at the start of a new deposit flow (so the stealth
   * derivation can be keyed by it before the server is involved). When
   * present, the server uses it verbatim as the receipt's positionId
   * instead of generating one. When absent (back-compat), the server
   * generates as before.
   */
  positionId?: string;
}

export interface PreparePrivateDepositResponse {
  receipt: PrivacyReceipt;
  positionId: string;
}

export interface DepositsControllerConfig {
  /** Allowed mixer pool denominations (lamports). First entry is the default. */
  denominationsLamports: readonly bigint[];
}

export function createDepositsController(
  privacy: PrivacyAdapter,
  config: DepositsControllerConfig,
) {
  return {
    /**
     * POST /deposits/prepare-private
     *
     * Entry point for the "Deposit privately" flow. The browser has already
     * derived a stealth keypair from a wallet signature and sends only the
     * pubkey here — the server never sees the seed.
     *
     * Single-sided SOL MVP: amount is fixed at the mixer denomination, so
     * the request carries pool + stealth + shape + range only.
     */
    async preparePrivate(
      req: FastifyRequest<{ Body: PreparePrivateDepositBody }>,
      reply: FastifyReply,
    ) {
      const body = req.body;

      const validation = validateBody(body);
      if (validation) return reply.status(400).send({ error: validation });

      const allowed = config.denominationsLamports;
      const defaultDenom = allowed[0]!;
      let chosen = defaultDenom;
      if (body.denominationLamports !== undefined) {
        let parsed: bigint;
        try {
          parsed = BigInt(body.denominationLamports);
        } catch {
          return reply.status(400).send({
            error: "denominationLamports must be a base-10 lamports string.",
          });
        }
        if (!allowed.some((d) => d === parsed)) {
          return reply.status(400).send({
            error: "denominationLamports does not match a configured pool.",
            requested: parsed.toString(),
            available: allowed.map((d) => d.toString()),
          });
        }
        chosen = parsed;
      }

      // Use the client-provided positionId when present (the browser
      // generated it before deriving stealth, so the v2 stealth key is
      // bound to this exact id). Otherwise generate as before — keeps
      // back-compat for any non-browser caller.
      let positionId: string;
      if (typeof body.positionId === "string" && body.positionId.length > 0) {
        // Cap the length so a malicious client can't bloat the receipt
        // store with arbitrary-size strings.
        if (body.positionId.length > 128) {
          return reply.status(400).send({
            error: "positionId must be ≤ 128 chars.",
          });
        }
        positionId = body.positionId;
      } else {
        positionId = `pos_${randomUUID()}`;
      }
      const receipt = await privacy.prepareFunding({
        positionId,
        intentId: positionId,
        poolSlug: body.poolAddress,
        amount: chosen.toString(),
        mode: "fast-private",
        stealthPubkey: body.stealthPubkey,
      });

      const response: PreparePrivateDepositResponse = { receipt, positionId };
      return reply.send(response);
    },
  };
}

function validateBody(body: PreparePrivateDepositBody): string | null {
  if (!body || typeof body !== "object") return "Body must be an object.";
  if (!body.poolAddress) return "poolAddress is required.";
  if (!body.stealthPubkey) return "stealthPubkey is required.";

  try {
    new PublicKey(body.poolAddress);
  } catch {
    return "poolAddress is not a valid Solana address.";
  }
  try {
    new PublicKey(body.stealthPubkey);
  } catch {
    return "stealthPubkey is not a valid Solana address.";
  }

  if (!["spot", "curve", "bid-ask"].includes(body.shape)) {
    return "shape must be one of spot|curve|bid-ask.";
  }
  if (
    !body.range ||
    typeof body.range.lower !== "number" ||
    typeof body.range.upper !== "number" ||
    body.range.lower > body.range.upper
  ) {
    return "range must be { lower, upper } with lower <= upper.";
  }
  return null;
}
