import type { FastifyReply, FastifyRequest } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { randomUUID } from "node:crypto";
import type { PrivacyAdapter, PrivacyReceipt } from "#modules/execution/adapters";

export interface PreparePrivateDepositBody {
  poolAddress: string;
  stealthPubkey: string;
  shape: "spot" | "curve" | "bid-ask";
  range: { lower: number; upper: number };
}

export interface PreparePrivateDepositResponse {
  receipt: PrivacyReceipt;
  positionId: string;
}

export interface DepositsControllerConfig {
  /** Fixed mixer pool denomination (lamports) — surfaced on the privacy receipt. */
  denominationLamports: bigint;
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

      const positionId = `pos_${randomUUID()}`;
      const receipt = await privacy.prepareFunding({
        positionId,
        intentId: positionId,
        poolSlug: body.poolAddress,
        amount: config.denominationLamports.toString(),
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
