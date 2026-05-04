import { Keypair } from "@solana/web3.js";
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * Stealth wallet — a fresh ephemeral keypair with zero mathematical link to the user's main wallet.
 *
 * Privacy model:
 *   - Random keypair generated per LP position
 *   - No derivation from main wallet = no traceable link, even off-chain
 *   - Seed is encrypted using a key from the user's wallet signature
 *   - Recovery: user signs the same message → decryption key → recover seed
 *
 * Flow:
 *   1. Generate random stealth keypair
 *   2. Encrypt the seed with a key derived from user's signMessage()
 *   3. Store encrypted blob (client-side or backend)
 *   4. To recover: user signs message again → decrypt → Keypair.fromSeed()
 */
export interface StealthWallet {
  /** The public key (address) that receives the withdrawal. */
  publicKey: string;
  /** The full keypair for signing LP transactions. */
  keypair: Keypair;
  /** Raw 32-byte seed (handle with care — only lives in memory). */
  seed: Buffer;
}

/** Encrypted seed blob that can be safely stored. */
export interface EncryptedSeed {
  /** AES-256-GCM encrypted seed. */
  ciphertext: string;
  /** Initialization vector (hex). */
  iv: string;
  /** Authentication tag (hex). */
  authTag: string;
  /** The stealth public key this seed belongs to. */
  publicKey: string;
  /**
   * Key-derivation version.
   *   1 — legacy: AES key = first 32 bytes of the input (raw signature slice).
   *   2 — HKDF-SHA256 over the input with a fixed domain separator.
   * Missing field is treated as v1 for backward compatibility.
   */
  version?: number;
}

const HKDF_INFO = Buffer.from("octora.stealth.seed.v2");
// HKDF salt is non-secret and fixed — it just provides domain separation
// across application contexts that might share the same input keying material.
const HKDF_SALT = Buffer.from("octora-stealth-salt-v2");

/**
 * Derive a 32-byte AES-256-GCM key from input keying material (e.g. a wallet
 * signature) using HKDF-SHA256. Replaces the v1 raw-slice approach so that
 * the signature isn't reused as a key material directly.
 */
function deriveAesKey(ikm: Uint8Array): Buffer {
  // hkdfSync requires non-empty IKM
  if (ikm.length === 0) {
    throw new Error("Encryption input keying material must be non-empty.");
  }
  const out = hkdfSync("sha256", ikm, HKDF_SALT, HKDF_INFO, 32);
  return Buffer.from(out);
}

/**
 * Generate a fresh stealth wallet with random entropy.
 * No link to any other wallet — privacy by default.
 */
export function generateStealthWallet(): StealthWallet {
  const seed = randomBytes(32);
  const keypair = Keypair.fromSeed(seed);

  return {
    publicKey: keypair.publicKey.toBase58(),
    keypair,
    seed,
  };
}

/**
 * Encrypt a stealth wallet's seed for safe storage.
 *
 * @param wallet - The stealth wallet to encrypt
 * @param encryptionKey - input keying material (e.g. a wallet signature, ≥ 32 bytes).
 *   The actual AES key is derived via HKDF-SHA256 with a fixed domain separator;
 *   the input is never used directly as the key.
 */
export function encryptSeed(wallet: StealthWallet, encryptionKey: Uint8Array): EncryptedSeed {
  if (encryptionKey.length < 32) {
    throw new Error("Encryption key must be at least 32 bytes.");
  }

  const key = deriveAesKey(encryptionKey);
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([cipher.update(wallet.seed), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    publicKey: wallet.publicKey,
    version: 2,
  };
}

/**
 * Decrypt a stored seed and recover the stealth wallet.
 *
 * Supports both v2 blobs (HKDF-derived key) and v1 blobs (legacy raw slice)
 * by inspecting the `version` field on the encrypted payload.
 *
 * @param encrypted - The encrypted seed blob
 * @param encryptionKey - Same input keying material used to encrypt
 */
export function decryptSeed(encrypted: EncryptedSeed, encryptionKey: Uint8Array): StealthWallet {
  if (encryptionKey.length < 32) {
    throw new Error("Encryption key must be at least 32 bytes.");
  }

  const version = encrypted.version ?? 1;
  let key: Buffer;
  if (version === 1) {
    key = Buffer.from(encryptionKey.slice(0, 32));
  } else if (version === 2) {
    key = deriveAesKey(encryptionKey);
  } else {
    throw new Error(`Unsupported encrypted seed version: ${version}`);
  }

  const iv = Buffer.from(encrypted.iv, "hex");
  const authTag = Buffer.from(encrypted.authTag, "hex");
  const ciphertext = Buffer.from(encrypted.ciphertext, "hex");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const seed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const keypair = Keypair.fromSeed(seed);

  // Verify the decrypted key matches the expected public key
  if (keypair.publicKey.toBase58() !== encrypted.publicKey) {
    throw new Error("Decrypted seed does not match expected public key. Wrong encryption key?");
  }

  return {
    publicKey: keypair.publicKey.toBase58(),
    keypair,
    seed,
  };
}

/**
 * Recover a stealth wallet directly from a raw seed.
 * Only use when you already have the plaintext seed in memory.
 */
export function recoverStealthWallet(seed: Buffer): StealthWallet {
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
