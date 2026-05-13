import type { FastifyReply, FastifyRequest } from "fastify";
import { PublicKey } from "@solana/web3.js";
import type { RelayerService } from "./relayer.service.js";
import type { Groth16Proof } from "#modules/vault";
import {
  InvalidDenominationError,
  UnknownDenominationError,
  parseDenomination,
} from "#modules/mixer/mixer.registry";

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
  /** Optional — when omitted, the relayer uses the default denomination. */
  denomination?: string;
}

export interface WithdrawResponse {
  success: boolean;
  txSignature: string | null;
  recipient: string;
  amountLamports: string;
  feeLamports: string;
  error?: string;
}

export interface RelayerEntry {
  service: RelayerService;
  info: RelayerInfoResponse;
}

export type RelayerResolver = (denomination?: bigint) => RelayerEntry;

/**
 * Optional hooks plugged into the controller's withdraw pipeline.
 *
 * `preSubmit` fires after the denomination is resolved but before any
 * cryptographic work is done. Returning a string short-circuits the
 * withdrawal with that error message as an HTTP 400 — used by the
 * relayer route to enforce the anonymity-set gate before paying gas.
 *
 * `postCommit` fires after a successful on-chain withdrawal — used by
 * the relayer route to mark the nullifier as spent in the shared mixer
 * registry's anonymity-set tracker.
 */
export interface RelayerControllerHooks {
  preSubmit?: (entry: RelayerEntry, body: WithdrawBody) => Promise<void> | void;
  postCommit?: (entry: RelayerEntry, body: WithdrawBody, result: WithdrawResponse) => void;
}

/**
 * HTTP controller for the mixer relayer.
 *
 * The relayer never sees user secrets — it only re-broadcasts a Groth16
 * proof generated in the browser. It pays gas, deducts a fixed fee, and
 * deposits the net into the recipient stealth address baked into the proof.
 *
 * Denomination dispatch: the controller reads `denomination` from each
 * request (query for reads, body for writes) and calls the resolver to get
 * the right per-pool service + info. The single-pool deployment path passes
 * a resolver that ignores `denomination` and always returns the same entry.
 */
export function createRelayerController(
  resolve: RelayerResolver,
  infoBundle: unknown,
  hooks: RelayerControllerHooks = {},
) {
  function resolveEntry(
    denominationRaw: unknown,
    reply: FastifyReply,
  ): RelayerEntry | null {
    let denomination: bigint | null;
    try {
      denomination = parseDenomination(denominationRaw);
    } catch (err) {
      reply
        .status(400)
        .send({ error: err instanceof Error ? err.message : "invalid denomination" });
      return null;
    }
    try {
      return resolve(denomination ?? undefined);
    } catch (err) {
      if (err instanceof UnknownDenominationError) {
        reply.status(400).send({
          error: err.message,
          requested: err.requested.toString(),
          available: err.available.map((d) => d.toString()),
        });
        return null;
      }
      throw err;
    }
  }

  return {
    /**
     * GET /relayer/info — returns the multi-pool info bundle. Old clients
     * read `denominationLamports` + `mixerPoolAddress` (= the default pool);
     * new clients use the `pools` array to pick the entry matching the
     * user's denomination selection.
     */
    async getInfo(_req: FastifyRequest, reply: FastifyReply) {
      return reply.send(infoBundle);
    },

    /**
     * POST /relayer/withdraw
     *
     * Submit a Groth16-proven withdrawal. Proof and recipient are bound
     * together inside the proof's public signals; the relayer only adds
     * gas and a small fee.
     *
     * Privacy delay is enforced by RelayerService.checkPrivacyDelay (see
     * relayer.service.ts). The first time the relayer sees a Merkle root,
     * it arms a slot height and rejects with a typed error; only
     * subsequent withdrawals against the same root, after the configured
     * delay (`OCTORA_MIXER_PRIVACY_DELAY_MS`, default 13s ≈ 32 slots),
     * are accepted. This blocks the trivial deposit-then-withdraw-next-slot
     * timing correlation that collapses anonymity on a low-traffic pool.
     */
    async withdraw(req: FastifyRequest<{ Body: WithdrawBody }>, reply: FastifyReply) {
      const entry = resolveEntry(req.body?.denomination, reply);
      if (!entry) return;

      const body = req.body;
      const validation = validateWithdrawBody(body, entry.info);
      if (validation) return reply.status(400).send({ error: validation });

      if (hooks.preSubmit) {
        try {
          await hooks.preSubmit(entry, body);
        } catch (err) {
          if (err instanceof InvalidDenominationError) {
            return reply.status(400).send({ error: err.message });
          }
          // The route handler (relayer.routes.ts) catches AnonymitySetTooThinError
          // before this controller is ever called; any other error is unexpected.
          throw err;
        }
      }

      try {
        const result = await entry.service.processWithdrawal({
          proof: body.proof,
          publicSignals: body.publicSignals,
          root: body.root,
          nullifierHash: body.nullifierHash,
          recipient: body.recipient,
          relayer: entry.info.relayerPubkey,
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
        if (response.success && hooks.postCommit) {
          try {
            hooks.postCommit(entry, body, response);
          } catch {
            // Hooks are best-effort book-keeping (anonymity-set tracker,
            // analytics). A failure here must not affect the withdrawal's
            // user-visible outcome — it already succeeded on-chain.
          }
        }
        return reply.status(response.success ? 200 : 400).send(response);
      } catch (err) {
        if (err instanceof InvalidDenominationError) {
          return reply.status(400).send({ error: err.message });
        }
        req.log.error({ err }, "[/relayer/withdraw] failed");
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
  if (body.fee !== info.feeLamports) {
    return `fee must equal advertised relayer fee (${info.feeLamports}).`;
  }
  return null;
}
