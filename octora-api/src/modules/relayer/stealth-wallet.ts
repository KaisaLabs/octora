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
   *       Identical signature → identical AES key → identical ciphertext
   *       blobs across deposits (P0-16 audit finding).
   *   3 — HKDF-SHA256 with a per-blob random `nonce` mixed into `info`,
   *       so two encryptions of the same seed by the same wallet produce
   *       distinct, unlinkable ciphertexts. The nonce is non-secret (it
   *       must be persisted alongside the blob to decrypt later).
   * Missing field is treated as v1 for backward compatibility.
   */
  version?: number;
  /**
   * Per-blob HKDF nonce, hex-encoded. v3-only; treated as the empty string
   * when reading older blobs. Non-secret — its only purpose is to break
   * the deterministic-derivation linkage between identical inputs.
   */
  nonce?: string;
}

const HKDF_SALT_V2 = Buffer.from("octora-stealth-salt-v2");
const HKDF_INFO_V2 = Buffer.from("octora.stealth.seed.v2");
const HKDF_SALT_V3 = Buffer.from("octora-stealth-salt-v3");
const HKDF_INFO_V3_PREFIX = Buffer.from("octora.stealth.seed.v3:");
const NONCE_BYTE_LEN_V3 = 16;

function deriveAesKeyV2(ikm: Uint8Array): Buffer {
  if (ikm.length === 0) {
    throw new Error("Encryption input keying material must be non-empty.");
  }
  const out = hkdfSync("sha256", ikm, HKDF_SALT_V2, HKDF_INFO_V2, 32);
  return Buffer.from(out);
}

/**
 * v3 derivation: HKDF-SHA256 with a per-blob random nonce mixed into
 * `info`. Same user, same signature, same seed → distinct AES keys per
 * encryption call, breaking the cross-deposit linkability that the
 * v2 fixed-info layout left exposed.
 */
function deriveAesKeyV3(ikm: Uint8Array, nonce: Buffer): Buffer {
  if (ikm.length === 0) {
    throw new Error("Encryption input keying material must be non-empty.");
  }
  if (nonce.length === 0) {
    throw new Error("v3 derivation requires a non-empty nonce.");
  }
  const info = Buffer.concat([HKDF_INFO_V3_PREFIX, nonce]);
  const out = hkdfSync("sha256", ikm, HKDF_SALT_V3, info, 32);
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
 *   The actual AES key is derived via HKDF-SHA256 with a per-blob random
 *   nonce mixed into the HKDF info parameter (v3). Two encryptions of the
 *   same seed by the same wallet produce distinct, unlinkable ciphertexts.
 *   The nonce is non-secret and persisted on the returned blob.
 */
export function encryptSeed(wallet: StealthWallet, encryptionKey: Uint8Array): EncryptedSeed {
  if (encryptionKey.length < 32) {
    throw new Error("Encryption key must be at least 32 bytes.");
  }

  const nonce = randomBytes(NONCE_BYTE_LEN_V3);
  const key = deriveAesKeyV3(encryptionKey, nonce);
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([cipher.update(wallet.seed), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    publicKey: wallet.publicKey,
    version: 3,
    nonce: nonce.toString("hex"),
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
    key = deriveAesKeyV2(encryptionKey);
  } else if (version === 3) {
    if (!encrypted.nonce) {
      throw new Error("v3 encrypted seed is missing the per-blob `nonce` field.");
    }
    key = deriveAesKeyV3(encryptionKey, Buffer.from(encrypted.nonce, "hex"));
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
