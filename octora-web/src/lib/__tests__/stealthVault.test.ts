/**
 * Test plan IDs covered:
 *   FE-WAL-003 wallet provider absent or missing signMessage → typed error
 *   FE-DEP-006 same wallet + same pool ⇒ same stealth keypair (recoverable)
 *   FE-DEP-007 (boundary) different pools yield different stealth keys
 *   OPS-SEC-002 derivation message includes the pool address but never the
 *               raw signature; nothing is persisted across `clearStealthCache`
 *
 * The stealth keypair is the privacy boundary between origin and
 * stealth wallets, so it deserves a tight unit test even though the
 * implementation is small. We mock window.solana with a deterministic
 * signMessage so the same wallet always returns the same signature.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  clearStealthCache,
  deriveStealthForPool,
  deriveStealthForPosition,
} from "../stealthVault";

interface MockProvider {
  signMessage: ReturnType<typeof vi.fn>;
}

function installMockProvider(signature: Uint8Array): MockProvider {
  const signMessage = vi.fn(async (_msg: Uint8Array, _enc?: "utf8") => ({
    signature,
  }));
  // Match the lookup order in stealthVault.getSigningProvider().
  (window as unknown as { phantom?: { solana: MockProvider } }).phantom = {
    solana: { signMessage },
  };
  return { signMessage };
}

function uninstallProvider() {
  const w = window as unknown as {
    phantom?: unknown;
    solana?: unknown;
    backpack?: unknown;
    solflare?: unknown;
  };
  delete w.phantom;
  delete w.solana;
  delete w.backpack;
  delete w.solflare;
}

beforeEach(() => {
  uninstallProvider();
  clearStealthCache();
});

afterEach(() => {
  uninstallProvider();
  clearStealthCache();
});

describe("deriveStealthForPool", () => {
  it("FE-DEP-006: same wallet + same pool always derives the same stealth keypair", async () => {
    const fixedSig = new Uint8Array(64).fill(7);
    installMockProvider(fixedSig);

    const a = await deriveStealthForPool({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool1",
    });

    // Force a re-derivation by clearing the cache.
    clearStealthCache();

    // Reinstall provider for the second call.
    uninstallProvider();
    installMockProvider(fixedSig);

    const b = await deriveStealthForPool({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool1",
    });

    expect(a.publicKey).toBe(b.publicKey);
    expect(a.keypair.secretKey).toEqual(b.keypair.secretKey);
  });

  it("FE-DEP-007: different pools produce different stealth identities", async () => {
    // Different signatures (one per pool) — production-realistic since the
    // signed message includes the pool address.
    let nextByte = 0;
    const provider = {
      signMessage: vi.fn(async () => ({
        signature: new Uint8Array(64).fill(nextByte++),
      })),
    };
    (window as unknown as { phantom?: { solana: typeof provider } }).phantom = {
      solana: provider,
    };

    const a = await deriveStealthForPool({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool1",
    });
    const b = await deriveStealthForPool({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool2",
    });

    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it("OPS-SEC-002: signMessage receives a message containing the pool address (and only public data)", async () => {
    const provider = installMockProvider(new Uint8Array(64));
    await deriveStealthForPool({
      mainWalletAddress: "wallet-A",
      poolAddress: "PoolXYZ",
    });

    expect(provider.signMessage).toHaveBeenCalledTimes(1);
    const [encoded] = provider.signMessage.mock.calls[0];
    const message = new TextDecoder().decode(encoded as Uint8Array);
    expect(message).toMatch(/PoolXYZ/);
    expect(message).toMatch(/Octora · Authorize private session/);
    // The wallet address must NOT appear in the signed message — pool-only,
    // so the same pool can be re-derived later when only the pool address
    // is in scope.
    expect(message).not.toMatch(/wallet-A/);
  });

  it("FE-WAL-003: throws a typed error when no provider has signMessage", async () => {
    // No provider installed.
    await expect(
      deriveStealthForPool({
        mainWalletAddress: "wallet-A",
        poolAddress: "Pool1",
      }),
    ).rejects.toThrow(/does not support signMessage/);
  });

  it("OPS-SEC-002: clearStealthCache forces a re-prompt on the next call", async () => {
    const provider = installMockProvider(new Uint8Array(64).fill(3));
    await deriveStealthForPool({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool1",
    });
    expect(provider.signMessage).toHaveBeenCalledTimes(1);

    // Same args within the same session — cache hit, no second prompt.
    await deriveStealthForPool({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool1",
    });
    expect(provider.signMessage).toHaveBeenCalledTimes(1);

    clearStealthCache();
    await deriveStealthForPool({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool1",
    });
    expect(provider.signMessage).toHaveBeenCalledTimes(2);
  });

  it("returned publicKey matches Keypair.fromSeed(SHA-256(signature)).publicKey", async () => {
    const sig = new Uint8Array(64).fill(11);
    installMockProvider(sig);

    const derived = await deriveStealthForPool({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool1",
    });

    const seed = new Uint8Array(
      await crypto.subtle.digest("SHA-256", sig as BufferSource),
    );
    const expected = Keypair.fromSeed(seed);
    expect(derived.publicKey).toBe(expected.publicKey.toBase58());
  });
});

describe("deriveStealthForPosition", () => {
  it("same positionId always derives the same stealth keypair", async () => {
    const fixedSig = new Uint8Array(64).fill(13);
    installMockProvider(fixedSig);

    const a = await deriveStealthForPosition({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool1",
      positionId: "pos-abc",
    });

    clearStealthCache();
    uninstallProvider();
    installMockProvider(fixedSig);

    const b = await deriveStealthForPosition({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool1",
      positionId: "pos-abc",
    });

    expect(a.publicKey).toBe(b.publicKey);
    expect(a.keypair.secretKey).toEqual(b.keypair.secretKey);
  });

  it("different positionIds in the same pool produce different stealth identities", async () => {
    // Mock returns a per-call distinct signature so a real wallet's
    // different-message-different-signature property is preserved.
    let nextByte = 0;
    const provider = {
      signMessage: vi.fn(async () => ({
        signature: new Uint8Array(64).fill(nextByte++),
      })),
    };
    (window as unknown as { phantom?: { solana: typeof provider } }).phantom = {
      solana: provider,
    };

    const a = await deriveStealthForPosition({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool1",
      positionId: "pos-001",
    });
    const b = await deriveStealthForPosition({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool1",
      positionId: "pos-002",
    });

    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it("signed message contains both pool and positionId", async () => {
    const provider = installMockProvider(new Uint8Array(64));
    await deriveStealthForPosition({
      mainWalletAddress: "wallet-A",
      poolAddress: "PoolXYZ",
      positionId: "pos-001",
    });

    expect(provider.signMessage).toHaveBeenCalledTimes(1);
    const [encoded] = provider.signMessage.mock.calls[0];
    const message = new TextDecoder().decode(encoded as Uint8Array);
    expect(message).toMatch(/PoolXYZ/);
    expect(message).toMatch(/pos-001/);
    expect(message).toMatch(/Version: 2/);
  });

  it("v1 and v2 derivations for the same (wallet, pool) produce different stealths", async () => {
    // Per-pool v1 and per-position v2 sign different messages, so the
    // resulting keypairs MUST differ. Otherwise re-deriving an old
    // position with the new function would accidentally collide.
    let nextByte = 0;
    const provider = {
      signMessage: vi.fn(async () => ({
        signature: new Uint8Array(64).fill(nextByte++),
      })),
    };
    (window as unknown as { phantom?: { solana: typeof provider } }).phantom = {
      solana: provider,
    };

    const v1 = await deriveStealthForPool({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool1",
    });
    const v2 = await deriveStealthForPosition({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool1",
      positionId: "pos-001",
    });

    expect(v1.publicKey).not.toBe(v2.publicKey);
  });

  it("cache key includes positionId so two positions don't share a cache slot", async () => {
    let nextByte = 0;
    const provider = {
      signMessage: vi.fn(async () => ({
        signature: new Uint8Array(64).fill(nextByte++),
      })),
    };
    (window as unknown as { phantom?: { solana: typeof provider } }).phantom = {
      solana: provider,
    };

    await deriveStealthForPosition({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool1",
      positionId: "pos-001",
    });
    await deriveStealthForPosition({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool1",
      positionId: "pos-002",
    });
    // Two distinct positions → two prompts.
    expect(provider.signMessage).toHaveBeenCalledTimes(2);

    // Re-deriving the first one is a cache hit, no extra prompt.
    await deriveStealthForPosition({
      mainWalletAddress: "wallet-A",
      poolAddress: "Pool1",
      positionId: "pos-001",
    });
    expect(provider.signMessage).toHaveBeenCalledTimes(2);
  });
});
