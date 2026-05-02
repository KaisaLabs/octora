import { Keypair } from "@solana/web3.js";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

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
 * @param encryptionKey - 32 bytes derived from user's wallet signature (use first 32 bytes of signature)
 */
export function encryptSeed(wallet: StealthWallet, encryptionKey: Uint8Array): EncryptedSeed {
  if (encryptionKey.length < 32) {
    throw new Error("Encryption key must be at least 32 bytes.");
  }

  const key = encryptionKey.slice(0, 32);
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([cipher.update(wallet.seed), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    publicKey: wallet.publicKey,
  };
}

/**
 * Decrypt a stored seed and recover the stealth wallet.
 *
 * @param encrypted - The encrypted seed blob
 * @param encryptionKey - Same key used to encrypt (from user's wallet signature)
 */
export function decryptSeed(encrypted: EncryptedSeed, encryptionKey: Uint8Array): StealthWallet {
  if (encryptionKey.length < 32) {
    throw new Error("Encryption key must be at least 32 bytes.");
  }

  const key = encryptionKey.slice(0, 32);
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
