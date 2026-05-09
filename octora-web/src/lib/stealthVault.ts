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
 * Build the message we ask the wallet to sign. Includes a stable version
 * tag and the pool address so each pool gets its own stealth identity.
 * Bumping the version (or adding a nonce) invalidates all derived keys.
 */
function buildDerivationMessage(poolAddress: string): string {
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
 * Derive (or recover) the stealth keypair for the given pool.
 *
 * `mainWalletAddress` is part of the cache key so that switching wallets
 * mid-session doesn't accidentally hand out the wrong stealth identity.
 */
export async function deriveStealthForPool(args: {
  mainWalletAddress: string;
  poolAddress: string;
}): Promise<DerivedStealth> {
  const cacheKey = `${args.mainWalletAddress}:${args.poolAddress}`;
  const cached = SESSION_CACHE.get(cacheKey);
  if (cached) {
    return { keypair: cached, publicKey: cached.publicKey.toBase58() };
  }

  const provider = getSigningProvider();
  const message = buildDerivationMessage(args.poolAddress);
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
