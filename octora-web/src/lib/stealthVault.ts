import { Keypair } from "@solana/web3.js";

/**
 * Stealth vault — wallet-derived deterministic stealth keypair.
 *
 * Privacy model:
 *   1. The user signs a fixed, deterministic message with their main wallet
 *      (a free signMessage, not an on-chain tx).
 *   2. We SHA-256 the signature to produce a 32-byte seed.
 *   3. The seed yields a Solana Keypair via Keypair.fromSeed(). Same wallet +
 *      same message ⇒ same stealth keypair, every time, on any device.
 *
 * Why this is safe for mainnet:
 *   - Nothing is stored. Browser cache cleared, new device, mobile — still
 *     recoverable from the same wallet.
 *   - The signature never leaves the browser. Only the stealth pubkey hits
 *     chain, so on-chain unlinkability is preserved.
 *   - Failure mode = "user lost their main wallet", which is the same failure
 *     mode they already accept for everything else they own.
 *
 * UX: the first signMessage call per (wallet, pool) shows one wallet popup.
 * We cache the derived keypair in memory for the session so the same flow
 * (deposit then later withdraw) can run without re-prompting.
 */

interface SignableProvider {
  signMessage?: (
    message: Uint8Array,
    encoding?: "utf8",
  ) => Promise<{ signature: Uint8Array }>;
}

interface InjectedWindow {
  solana?: SignableProvider & { isPhantom?: boolean };
  phantom?: { solana?: SignableProvider };
  solflare?: SignableProvider;
  backpack?: { solana?: SignableProvider };
}

const SESSION_CACHE = new Map<string, Keypair>();

/**
 * v1 derivation message — same wallet + same pool always yields the same
 * stealth. Retained as a backward-compat path for devnet positions opened
 * before the per-position derivation landed (StoredPosition entries
 * without a `derivationVersion` field).
 */
function buildDerivationMessageV1(poolAddress: string): string {
  return [
    "Octora · Authorize private session",
    "",
    "Version: 1",
    `Pool: ${poolAddress}`,
    "",
    "This signature derives the private address for your position.",
    "It does not authorize any on-chain transaction or token transfer.",
  ].join("\n");
}

/**
 * v2 derivation message — same wallet + same pool + same positionId yields
 * the same stealth. Different positions in the same pool get different
 * stealths, so an on-chain observer (or a portfolio explorer the user
 * inadvertently pasted into) sees only that one position, not the user's
 * full LP footprint.
 *
 * positionId is a browser-generated UUIDv4 created at the start of a new
 * deposit flow; persisted in localPositions so claim/exit can re-derive.
 */
function buildDerivationMessageV2(poolAddress: string, positionId: string): string {
  return [
    "Octora · Authorize private session",
    "",
    "Version: 2",
    `Pool: ${poolAddress}`,
    `Position: ${positionId}`,
    "",
    "This signature derives the private address for THIS SPECIFIC position.",
    "Different positions get different addresses so they can't be linked.",
    "It does not authorize any on-chain transaction or token transfer.",
  ].join("\n");
}

/** Return the wallet's signMessage handle, regardless of which extension is installed. */
function getSigningProvider(): SignableProvider {
  const w = window as unknown as InjectedWindow;
  const candidates: Array<SignableProvider | undefined> = [
    w.phantom?.solana,
    w.solana,
    w.backpack?.solana,
    w.solflare,
  ];
  const hit = candidates.find((p) => p && typeof p.signMessage === "function");
  if (!hit) throw new Error("Connected wallet does not support signMessage.");
  return hit;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Re-wrap into a fresh ArrayBuffer-backed Uint8Array so the type matches
  // BufferSource — TS 5.x distinguishes Uint8Array<ArrayBufferLike> (which
  // includes SharedArrayBuffer) from Uint8Array<ArrayBuffer>, and
  // crypto.subtle.digest's signature only accepts the latter.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
  return new Uint8Array(digest);
}

export interface DerivedStealth {
  /** Solana keypair the browser uses to sign DLMM lifecycle txs. */
  keypair: Keypair;
  /** Base58 stealth address. */
  publicKey: string;
}

/**
 * Derive (or recover) the v1 stealth keypair for the given pool.
 *
 * @deprecated Use `deriveStealthForPosition` for new flows. v1 derivation
 * keys all of a wallet's positions in a pool to the same stealth, which
 * lets an on-chain observer link them. Retained only for backward-compat
 * with existing StoredPosition entries that predate the per-position
 * change (those entries' `derivationVersion` field is missing or "v1").
 */
export async function deriveStealthForPool(args: {
  mainWalletAddress: string;
  poolAddress: string;
}): Promise<DerivedStealth> {
  const cacheKey = `v1:${args.mainWalletAddress}:${args.poolAddress}`;
  const cached = SESSION_CACHE.get(cacheKey);
  if (cached) {
    return { keypair: cached, publicKey: cached.publicKey.toBase58() };
  }

  const provider = getSigningProvider();
  const message = buildDerivationMessageV1(args.poolAddress);
  const encoded = new TextEncoder().encode(message);
  const { signature } = await provider.signMessage!(encoded, "utf8");

  const seed = await sha256(signature);
  const keypair = Keypair.fromSeed(seed);

  SESSION_CACHE.set(cacheKey, keypair);
  return { keypair, publicKey: keypair.publicKey.toBase58() };
}

/**
 * Derive (or recover) the v2 stealth keypair for a specific position.
 *
 * Each position gets its own stealth: the user signs a derivation message
 * that includes the position's UUID, so two deposits into the same pool
 * produce two distinct on-chain identities. This is the privacy boundary
 * that lets users open multiple positions without an observer linking
 * them through a shared stealth address.
 *
 * `positionId` is a UUIDv4 generated browser-side at the start of a new
 * deposit flow and persisted alongside the position in localPositions.
 * Claim / exit re-derives by passing the same positionId.
 *
 * Cache key includes positionId so the same orchestrator run reuses the
 * keypair across its 11+ steps without re-prompting the wallet.
 */
export async function deriveStealthForPosition(args: {
  mainWalletAddress: string;
  poolAddress: string;
  positionId: string;
}): Promise<DerivedStealth> {
  const cacheKey = `v2:${args.mainWalletAddress}:${args.poolAddress}:${args.positionId}`;
  const cached = SESSION_CACHE.get(cacheKey);
  if (cached) {
    return { keypair: cached, publicKey: cached.publicKey.toBase58() };
  }

  const provider = getSigningProvider();
  const message = buildDerivationMessageV2(args.poolAddress, args.positionId);
  const encoded = new TextEncoder().encode(message);
  const { signature } = await provider.signMessage!(encoded, "utf8");

  const seed = await sha256(signature);
  const keypair = Keypair.fromSeed(seed);

  SESSION_CACHE.set(cacheKey, keypair);
  return { keypair, publicKey: keypair.publicKey.toBase58() };
}

/** Drop cached keypairs — call on wallet disconnect. */
export function clearStealthCache(): void {
  SESSION_CACHE.clear();
}
