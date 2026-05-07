import type { FastifyReply, FastifyRequest } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { randomUUID } from "node:crypto";
import type { PrivacyAdapter, PrivacyReceipt } from "#modules/execution/adapters";

export interface PreparePrivateDepositBody {
  poolAddress: string;
  stealthPubkey: string;
  amountUsd: number;
  shape: "spot" | "curve" | "bid-ask";
  range: { lower: number; upper: number };
  allocation: { tokenA: number; tokenB: number };
}

export interface PreparePrivateDepositResponse {
  receipt: PrivacyReceipt;
  positionId: string;
}

export function createDepositsController(privacy: PrivacyAdapter) {
  return {
    /**
     * POST /deposits/prepare-private
     *
     * Entry point for the "Deposit privately" flow. The browser has already
     * derived a stealth keypair from a wallet signature and sends only the
     * pubkey here — the server never sees the seed.
     *
     * Returns a privacy receipt + a positionId the browser carries through
     * the executor lifecycle (init-position → add-liquidity).
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
        amount: body.amountUsd.toString(),
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

  if (typeof body.amountUsd !== "number" || body.amountUsd <= 0) {
    return "amountUsd must be a positive number.";
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
  if (
    !body.allocation ||
    typeof body.allocation.tokenA !== "number" ||
    typeof body.allocation.tokenB !== "number"
  ) {
    return "allocation.tokenA and allocation.tokenB must be numbers.";
  }
  return null;
}
