import type { FastifyReply, FastifyRequest } from "fastify";
import { PublicKey } from "@solana/web3.js";
import type { RelayerService } from "./relayer.service.js";
import type { Groth16Proof } from "#modules/vault";

export interface RelayerInfoResponse {
  /** Relayer hot wallet pubkey — the proof public input `relayer` field. */
  relayerPubkey: string;
  /** Lamports the relayer deducts per withdrawal (also a proof public input). */
  feeLamports: string;
  /** Mixer pool denomination in lamports — the fixed deposit/withdrawal amount. */
  denominationLamports: string;
  /** Mixer pool PDA, for browser-side commitment lookup. */
  mixerPoolAddress: string;
}

export interface WithdrawBody {
  proof: Groth16Proof;
  publicSignals: string[];
  root: string;
  nullifierHash: string;
  recipient: string;
  fee: string;
}

export interface WithdrawResponse {
  success: boolean;
  txSignature: string | null;
  recipient: string;
  amountLamports: string;
  feeLamports: string;
  error?: string;
}

/**
 * HTTP controller for the mixer relayer.
 *
 * The relayer never sees user secrets — it only re-broadcasts a Groth16
 * proof generated in the browser. It pays gas, deducts a fixed fee, and
 * deposits the net into the recipient stealth address baked into the proof.
 */
export function createRelayerController(
  relayer: RelayerService,
  info: RelayerInfoResponse,
) {
  return {
    async getInfo(_req: FastifyRequest, reply: FastifyReply) {
      return reply.send(info);
    },

    /**
     * POST /relayer/withdraw
     *
     * Submit a Groth16-proven withdrawal. Proof and recipient are bound
     * together inside the proof's public signals; the relayer only adds
     * gas and a small fee.
     *
     * TODO(mainnet): enforce a minimum slot delay between the deposit
     * that produced this commitment and the withdrawal that spends it.
     * MVP runs back-to-back to keep dev tests fast — this is a privacy
     * footgun on a busy pool and must be gated before mainnet launch.
     */
    async withdraw(req: FastifyRequest<{ Body: WithdrawBody }>, reply: FastifyReply) {
      const body = req.body;
      const validation = validateWithdrawBody(body, info);
      if (validation) return reply.status(400).send({ error: validation });

      try {
        const result = await relayer.processWithdrawal({
          proof: body.proof,
          publicSignals: body.publicSignals,
          root: body.root,
          nullifierHash: body.nullifierHash,
          recipient: body.recipient,
          relayer: info.relayerPubkey,
          fee: body.fee,
        });

        const response: WithdrawResponse = {
          success: result.success,
          txSignature: result.txSignature,
          recipient: result.recipient,
          amountLamports: result.amountLamports,
          feeLamports: result.feeLamports,
          error: result.error,
        };
        return reply.status(result.success ? 200 : 400).send(response);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[/relayer/withdraw] failed:", err instanceof Error ? err.stack : err);
        return reply
          .status(400)
          .send({ error: err instanceof Error ? err.message : "withdraw build failed" });
      }
    },
  };
}

function validateWithdrawBody(body: WithdrawBody, info: RelayerInfoResponse): string | null {
  if (!body || typeof body !== "object") return "Body must be an object.";
  if (!body.proof || typeof body.proof !== "object") return "proof is required.";
  if (!Array.isArray(body.publicSignals) || body.publicSignals.length !== 5) {
    return "publicSignals must be an array of 5 field elements.";
  }
  if (typeof body.root !== "string") return "root is required.";
  if (typeof body.nullifierHash !== "string") return "nullifierHash is required.";
  if (typeof body.recipient !== "string") return "recipient is required.";
  if (typeof body.fee !== "string") return "fee is required.";
  try {
    new PublicKey(body.recipient);
  } catch {
    return "recipient is not a valid Solana address.";
  }
  // Pin the fee to what the relayer advertises so a client can't trick the
  // proof verifier into accepting a 0-fee withdrawal against an info-bound
  // public signal.
  if (body.fee !== info.feeLamports) {
    return `fee must equal advertised relayer fee (${info.feeLamports}).`;
  }
  return null;
}
