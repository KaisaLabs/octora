import { describe, it, expect } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { generateStealthWallet, encryptSeed, decryptSeed, recoverStealthWallet } from "../stealth-wallet.js";

describe("StealthWallet", () => {
  describe("generateStealthWallet", () => {
    it("generates a valid keypair", () => {
      const wallet = generateStealthWallet();

      expect(wallet.publicKey).toBeTruthy();
      expect(wallet.keypair).toBeDefined();
      expect(wallet.seed).toHaveLength(32);
    });

    it("generates unique wallets each time (no link between them)", () => {
      const w1 = generateStealthWallet();
      const w2 = generateStealthWallet();

      expect(w1.publicKey).not.toBe(w2.publicKey);
      expect(Buffer.compare(w1.seed, w2.seed)).not.toBe(0);
    });
  });

  describe("encryptSeed / decryptSeed", () => {
    // Simulates: user signs a message → first 32 bytes of signature = encryption key
    const encryptionKey = randomBytes(64); // signature is 64 bytes

    it("encrypts and decrypts a stealth wallet seed", () => {
      const wallet = generateStealthWallet();
      const encrypted = encryptSeed(wallet, encryptionKey);

      expect(encrypted.ciphertext).toBeTruthy();
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.authTag).toBeTruthy();
      expect(encrypted.publicKey).toBe(wallet.publicKey);

      const recovered = decryptSeed(encrypted, encryptionKey);
      expect(recovered.publicKey).toBe(wallet.publicKey);
      expect(Buffer.compare(recovered.seed, wallet.seed)).toBe(0);
    });

    it("fails with wrong encryption key", () => {
      const wallet = generateStealthWallet();
      const encrypted = encryptSeed(wallet, encryptionKey);

      const wrongKey = randomBytes(64);
      expect(() => decryptSeed(encrypted, wrongKey)).toThrow();
    });

    it("encrypted blob contains no plaintext seed", () => {
      const wallet = generateStealthWallet();
      const encrypted = encryptSeed(wallet, encryptionKey);

      // The ciphertext should not contain the raw seed hex
      const seedHex = wallet.seed.toString("hex");
      expect(encrypted.ciphertext).not.toBe(seedHex);
    });

    it("rejects encryption key shorter than 32 bytes", () => {
      const wallet = generateStealthWallet();
      const shortKey = randomBytes(16);

      expect(() => encryptSeed(wallet, shortKey)).toThrow("at least 32 bytes");
    });

    it("each encryption produces different ciphertext (random IV)", () => {
      const wallet = generateStealthWallet();
      const e1 = encryptSeed(wallet, encryptionKey);
      const e2 = encryptSeed(wallet, encryptionKey);

      expect(e1.iv).not.toBe(e2.iv);
      expect(e1.ciphertext).not.toBe(e2.ciphertext);
    });

    it("tags new blobs as version 2 (HKDF)", () => {
      const wallet = generateStealthWallet();
      const encrypted = encryptSeed(wallet, encryptionKey);
      expect(encrypted.version).toBe(2);
    });

    it("can still decrypt legacy v1 blobs (raw signature slice)", () => {
      const wallet = generateStealthWallet();
      // Hand-build a v1 blob using the pre-HKDF derivation:
      //   key = first 32 bytes of the input directly.
      const iv = randomBytes(12);
      const cipher = createCipheriv(
        "aes-256-gcm",
        Buffer.from(encryptionKey.slice(0, 32)),
        iv,
      );
      const ciphertext = Buffer.concat([cipher.update(wallet.seed), cipher.final()]);
      const authTag = cipher.getAuthTag();

      const legacy = {
        ciphertext: ciphertext.toString("hex"),
        iv: iv.toString("hex"),
        authTag: authTag.toString("hex"),
        publicKey: wallet.publicKey,
        // no version field → treated as v1
      };

      const recovered = decryptSeed(legacy, encryptionKey);
      expect(recovered.publicKey).toBe(wallet.publicKey);
      expect(Buffer.compare(recovered.seed, wallet.seed)).toBe(0);
    });
  });

  describe("recoverStealthWallet", () => {
    it("recovers the same wallet from the same seed", () => {
      const original = generateStealthWallet();
      const recovered = recoverStealthWallet(original.seed);

      expect(recovered.publicKey).toBe(original.publicKey);
    });

    it("rejects invalid seed length", () => {
      expect(() => recoverStealthWallet(Buffer.alloc(16))).toThrow("exactly 32 bytes");
    });
  });
});
