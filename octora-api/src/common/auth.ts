import { createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { PublicKey } from "@solana/web3.js";

import type { AuthRepository } from "#modules/auth/auth.repository";

import { ApiError } from "./errors/index.js";

/**
 * Wallet-signature auth.
 *
 * The browser flow is:
 *
 *   1. `POST /auth/nonce` with body `{ walletAddress }` → server returns
 *      `{ nonce, expiresAt }`. Nonce is a fresh 32-byte random hex string
 *      stored in `AuthNonce` and bound to the wallet at issue time.
 *   2. Browser signs the literal nonce string (UTF-8 bytes) with the
 *      connected wallet (`signMessage`).
 *   3. On every mutating call the browser sends three headers:
 *        - `x-wallet-address`: base58 pubkey
 *        - `x-signed-nonce`:   the nonce returned in step 1
 *        - `x-signature`:      base64 of the 64-byte Ed25519 signature
 *      `requireWalletSignature` verifies the signature, marks the nonce
 *      used (single-shot), and stamps `request.wallet` for downstream
 *      handlers / `requireBetaAccess`.
 *
 * Why one nonce per call: re-using a single long-lived signature would let
 * a network attacker who captures one request replay it indefinitely. A
 * one-shot nonce moves the replay window to the lifetime of one in-flight
 * request, which is what the audit (P0-20) asks for.
 */

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const NONCE_BYTE_LEN = 32;

/** SubjectPublicKeyInfo DER prefix for Ed25519 raw 32-byte keys. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface AuthenticatedWallet {
  /** Base58-encoded Solana pubkey. */
  address: string;
  /** Raw 32-byte pubkey. */
  pubkey: PublicKey;
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Set by `requireWalletSignature` after a valid signed nonce is seen.
     * Downstream handlers can trust this field is present *only* because
     * the preHandler ran — it is never copied from request input.
     */
    wallet?: AuthenticatedWallet;
  }
}

/**
 * Issue a fresh one-time nonce for `walletAddress`. Persists to `AuthNonce`
 * with `used = false`. The browser signs and presents back as
 * `x-signed-nonce`.
 */
export async function issueAuthNonce(
  authRepo: AuthRepository,
  walletAddress: string,
): Promise<{ nonce: string; expiresAt: Date }> {
  // Validate the wallet up-front so we don't store junk.
  try {
    new PublicKey(walletAddress);
  } catch {
    throw new AuthError("walletAddress is not a valid base58 Solana pubkey", 400);
  }

  const nonce = randomBytes(NONCE_BYTE_LEN).toString("hex");
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

  await authRepo.createNonce({ nonce, walletAddress, expiresAt });

  // Best-effort GC: the index on `expiresAt` keeps this cheap. We don't
  // care about the exact return value, only that the table doesn't grow
  // unboundedly under churn.
  await authRepo.pruneExpiredNonces(new Date(Date.now() - NONCE_TTL_MS));

  return { nonce, expiresAt };
}

/**
 * Fastify preHandler — enforces wallet-signature auth on a route.
 *
 * On success: stamps `req.wallet` and lets the handler run.
 * On failure: replies 401/403 and short-circuits.
 */
export function requireWalletSignature(
  authRepo: AuthRepository,
): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const walletHeader = pickHeader(req, "x-wallet-address");
    const nonceHeader = pickHeader(req, "x-signed-nonce");
    const signatureHeader = pickHeader(req, "x-signature");

    if (!walletHeader || !nonceHeader || !signatureHeader) {
      return reply
        .code(401)
        .send({
          error: "Unauthorized",
          message:
            "Missing wallet auth headers (x-wallet-address, x-signed-nonce, x-signature).",
        });
    }

    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(walletHeader);
    } catch {
      return reply.code(401).send({
        error: "Unauthorized",
        message: "x-wallet-address is not a valid base58 Solana pubkey.",
      });
    }

    let signatureBytes: Buffer;
    try {
      signatureBytes = Buffer.from(signatureHeader, "base64");
    } catch {
      return reply
        .code(401)
        .send({ error: "Unauthorized", message: "x-signature is not valid base64." });
    }
    if (signatureBytes.length !== 64) {
      return reply.code(401).send({
        error: "Unauthorized",
        message: `x-signature must decode to 64 bytes; got ${signatureBytes.length}.`,
      });
    }

    // Look up the nonce. The repo's `claimNonce` is a single atomic
    // update-where — two concurrent requests presenting the same signed
    // nonce can't both pass (the second sees zero rows updated and we
    // fail closed).
    const claimed = await authRepo.claimNonce({
      nonce: nonceHeader,
      walletAddress: walletHeader,
      now: new Date(),
    });

    if (!claimed) {
      return reply.code(401).send({
        error: "Unauthorized",
        message:
          "x-signed-nonce is unknown, expired, already used, or bound to a different wallet.",
      });
    }

    const messageBytes = Buffer.from(nonceHeader, "utf8");
    const ok = verifyEd25519Detached(messageBytes, signatureBytes, pubkey.toBytes());
    if (!ok) {
      return reply.code(401).send({
        error: "Unauthorized",
        message: "x-signature failed Ed25519 verification against x-wallet-address.",
      });
    }

    req.wallet = { address: pubkey.toBase58(), pubkey };
  };
}

/**
 * Fastify preHandler — refuses requests whose authenticated wallet is not
 * in the `BetaAccess` table. Must run *after* `requireWalletSignature`.
 */
export function requireBetaAccess(authRepo: AuthRepository): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const wallet = req.wallet;
    if (!wallet) {
      return reply.code(500).send({
        error: "ServerMisconfigured",
        message:
          "requireBetaAccess invoked before requireWalletSignature — register them in order.",
      });
    }
    const ok = await authRepo.walletHasBetaAccess(wallet.address);
    if (!ok) {
      return reply.code(403).send({
        error: "Forbidden",
        message:
          "This wallet is not approved for the Octora beta. Apply via the waitlist.",
      });
    }
  };
}

/**
 * Asserts a request body's `walletAddress` field matches the authenticated
 * wallet. Returns null on success, a reply-already-sent sentinel on failure.
 *
 * Use inside controllers where the route body carries an explicit
 * `walletAddress` (e.g. `POST /positions/intents`). For routes where the
 * wallet is derived from a path-bound resource (e.g. a position lookup),
 * compare against the resource's stored wallet instead.
 */
export function assertBodyWalletMatchesAuth(
  req: FastifyRequest,
  reply: FastifyReply,
  bodyWallet: string | undefined,
): true | false {
  if (!req.wallet) {
    reply.code(500).send({
      error: "ServerMisconfigured",
      message: "Wallet auth must run before assertBodyWalletMatchesAuth.",
    });
    return false;
  }
  if (!bodyWallet || bodyWallet !== req.wallet.address) {
    reply.code(403).send({
      error: "Forbidden",
      message: "Request body walletAddress does not match the authenticated wallet.",
    });
    return false;
  }
  return true;
}

/**
 * Bearer-token gate for `/admin/*` routes. Compares with timing-safe equal
 * to keep length-leak attacks off the table even though the token isn't
 * derived from a hash.
 */
export function requireAdminToken(adminToken: string | null): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!adminToken) {
      return reply.code(503).send({
        error: "AdminDisabled",
        message: "Admin routes are disabled because OCTORA_ADMIN_API_TOKEN is unset.",
      });
    }
    const presented = pickHeader(req, "authorization") ?? "";
    const stripped = presented.startsWith("Bearer ")
      ? presented.slice("Bearer ".length)
      : presented;
    const a = Buffer.from(stripped, "utf8");
    const b = Buffer.from(adminToken, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return reply
        .code(401)
        .send({ error: "Unauthorized", message: "Bad admin bearer token." });
    }
  };
}

// --- internal helpers ---

/**
 * Verify a 64-byte detached Ed25519 signature against a raw 32-byte pubkey
 * using Node's built-in `crypto.verify`. Avoids the tweetnacl dependency.
 */
function verifyEd25519Detached(
  message: Buffer,
  signature: Buffer,
  rawPubkey: Uint8Array,
): boolean {
  if (rawPubkey.length !== 32) return false;
  if (signature.length !== 64) return false;
  try {
    const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawPubkey)]);
    const keyObj = createPublicKey({ key: der, format: "der", type: "spki" });
    return verify(null, message, keyObj, signature);
  } catch {
    return false;
  }
}

function pickHeader(req: FastifyRequest, key: string): string | null {
  const v = req.headers[key];
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v) && v.length > 0) return String(v[0]).trim();
  return null;
}

class AuthError extends ApiError {
  constructor(message: string, statusCode: number) {
    super(statusCode, "auth_error", message);
    this.name = "AuthError";
  }
}

export { AuthError };
