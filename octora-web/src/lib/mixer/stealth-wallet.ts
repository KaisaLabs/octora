// Browser-side stealth wallet generation + seed encryption.
//
// The keypair is generated locally — the server never sees the private key.
// The seed is encrypted with an HKDF-derived key compatible with the v2
// blob format on the relayer (octora-api/src/modules/relayer/stealth-wallet.ts),
// so the same encrypted blob can be decrypted by either side if needed.

import { Keypair } from "@solana/web3.js";

export interface StealthWallet {
  /** Base58 public key — the address that will receive withdrawn funds. */
  publicKey: string;
  /** Full Solana keypair, kept in memory only. */
  keypair: Keypair;
  /** Raw 32-byte seed. Treat with the same care as a private key. */
  seed: Uint8Array;
}

export interface EncryptedSeed {
  ciphertext: string;
  iv: string;
  authTag: string;
  publicKey: string;
  /** Always 2 in this module — HKDF-derived key. */
  version: 2;
}

const HKDF_INFO = new TextEncoder().encode("octora.stealth.seed.v2");
const HKDF_SALT = new TextEncoder().encode("octora-stealth-salt-v2");

/** Generate a fresh stealth wallet from CSPRNG entropy. */
export function generateStealthWallet(): StealthWallet {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  const keypair = Keypair.fromSeed(seed);
  return {
    publicKey: keypair.publicKey.toBase58(),
    keypair,
    seed,
  };
}

/**
 * Recover a stealth wallet from a known 32-byte seed.
 * Used after decrypting an EncryptedSeed blob.
 */
export function recoverStealthWallet(seed: Uint8Array): StealthWallet {
  if (seed.length !== 32) {
    throw new Error("Stealth wallet seed must be exactly 32 bytes.");
  }
  const keypair = Keypair.fromSeed(seed);
  return {
    publicKey: keypair.publicKey.toBase58(),
    keypair,
    seed,
  };
}

// Helper to silence TS5's distinction between ArrayBuffer and SharedArrayBuffer
// for our locally-allocated Uint8Arrays — none of these come from a SAB context.
function asBuf(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource;
}

async function deriveAesKey(ikm: Uint8Array): Promise<CryptoKey> {
  if (ikm.length === 0) throw new Error("IKM must be non-empty.");
  const baseKey = await crypto.subtle.importKey("raw", asBuf(ikm), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: asBuf(HKDF_SALT),
      info: asBuf(HKDF_INFO),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Encrypt the stealth wallet seed with an HKDF-derived AES-GCM key.
 *
 * `encryptionKey` is input keying material (e.g. the user's wallet
 * signature over a fixed message). It is never used directly as a key.
 *
 * Note: WebCrypto AES-GCM concatenates ciphertext || authTag in a single
 * output. We split them on encrypt and re-join on decrypt so the blob
 * shape matches the server's Node-crypto output.
 */
export async function encryptSeed(
  wallet: StealthWallet,
  encryptionKey: Uint8Array,
): Promise<EncryptedSeed> {
  if (encryptionKey.length < 32) {
    throw new Error("Encryption key must be at least 32 bytes.");
  }
  const key = await deriveAesKey(encryptionKey);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const combined = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: asBuf(iv) }, key, asBuf(wallet.seed)),
  );
  // WebCrypto appends a 16-byte auth tag at the end.
  const tagLen = 16;
  const ciphertext = combined.slice(0, combined.length - tagLen);
  const authTag = combined.slice(combined.length - tagLen);

  return {
    ciphertext: bytesToHex(ciphertext),
    iv: bytesToHex(iv),
    authTag: bytesToHex(authTag),
    publicKey: wallet.publicKey,
    version: 2,
  };
}

export async function decryptSeed(
  encrypted: EncryptedSeed,
  encryptionKey: Uint8Array,
): Promise<StealthWallet> {
  if (encryptionKey.length < 32) {
    throw new Error("Encryption key must be at least 32 bytes.");
  }
  if (encrypted.version !== 2) {
    throw new Error(
      `Unsupported encrypted seed version: ${encrypted.version}. Browser supports v2 only.`,
    );
  }

  const key = await deriveAesKey(encryptionKey);
  const iv = hexToBytes(encrypted.iv);
  const ciphertext = hexToBytes(encrypted.ciphertext);
  const authTag = hexToBytes(encrypted.authTag);

  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext, 0);
  combined.set(authTag, ciphertext.length);

  const seedBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asBuf(iv) },
    key,
    asBuf(combined),
  );
  const seed = new Uint8Array(seedBuf);
  const wallet = recoverStealthWallet(seed);
  if (wallet.publicKey !== encrypted.publicKey) {
    throw new Error("Decrypted seed does not match expected public key.");
  }
  return wallet;
}
