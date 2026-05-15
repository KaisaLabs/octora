/**
 * Tests for dust/04's user-signed Recover Funds orchestrator
 * (`runUserSignedRecovery`).
 *
 * Load-bearing assertion (per ADR-0004 + ticket AC):
 *   "Works against a stopped relayer (test by killing the relayer
 *    service before clicking)."
 *
 * Concretely we assert:
 *   1. `MissingWithdrawWitnessError` is thrown when no witness exists.
 *   2. The orchestrator never touches the backend relayer (`/relayer/*`)
 *      endpoints, even when those endpoints fail with 500s on every
 *      hit. The flow only depends on `/mixer/deposits` (read-only) and
 *      `/mixer/withdraw` (tx assembly, no signing) — the actual signing
 *      + broadcasting happens in the browser → RPC, never via the
 *      relayer.
 *   3. The witness is cleared from localStorage after a confirmed
 *      recovery (nullifier is single-use).
 *
 * We don't exercise the real ZK prover here — it's heavy + slow + needs
 * the wasm/zkey assets. Instead we stub `./mixer` so the orchestrator
 * exercises every other call site (network, wallet, RPC) deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MissingWithdrawWitnessError,
  runUserSignedRecovery,
} from "../userSignedRecovery";
import {
  listLocalPositions,
  recordMixerWithdrawWitness,
  type StoredPosition,
} from "../localPositions";

const MAIN_WALLET = "11111111111111111111111111111111";
const POOL_ADDRESS = "So11111111111111111111111111111111111111112";

function seedStoredPosition(positionId: string, withWitness: boolean): StoredPosition {
  const base: StoredPosition = {
    positionId,
    poolAddress: POOL_ADDRESS,
    positionPubkey: POOL_ADDRESS,
    stealthPubkey: POOL_ADDRESS,
    fundedLamports: "990000000",
    depositedUsd: 100,
    lowerBinId: -50,
    upperBinId: 50,
    shape: "spot",
    ts: 0,
    network: "devnet",
    derivationVersion: "v2",
    lifecycleStatus: "LP_FAILED",
  };

  // Persist via the public helper so the storage shape matches what
  // production code writes.
  window.localStorage.setItem(
    `octora.positions.v1.${MAIN_WALLET}`,
    JSON.stringify([base]),
  );

  if (withWitness) {
    recordMixerWithdrawWitness(MAIN_WALLET, positionId, {
      secret: "11111",
      nullifier: "22222",
      commitment: "33333",
      nullifierHash: "44444",
      leafIndex: 0,
      denominationLamports: "1000000000",
    });
  }

  return listLocalPositions(MAIN_WALLET).find((p) => p.positionId === positionId)!;
}

// Track every fetch URL the orchestrator hits so we can assert it
// never touches a relayer endpoint.
const fetchedUrls: string[] = [];

/**
 * Build a `fetch` stub that:
 *   - Returns a tiny `/mixer/deposits` list including our seeded commitment.
 *   - Returns a synthetic base64 "transaction" for `/mixer/withdraw`.
 *   - 500s on every other endpoint (simulates the relayer / state-machine
 *     endpoints being down — the load-bearing assertion).
 */
function offlineRelayerFetch(): typeof globalThis.fetch {
  return (async (url: RequestInfo | URL) => {
    const u = typeof url === "string" ? url : url.toString();
    fetchedUrls.push(u);

    if (u.includes("/mixer/deposits")) {
      return new Response(
        JSON.stringify({
          deposits: [
            { commitment: "33333", leafIndex: 0, txSignature: "deposit-sig" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes("/mixer/withdraw")) {
      // Minimal legacy-format Transaction so the orchestrator's
      // `Transaction.from` succeeds. The signer mock just returns the
      // tx untouched — we don't need a valid serialization for this
      // test (we mock the wallet + RPC).
      return new Response(
        JSON.stringify({ transaction: SYNTHETIC_TX_B64 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Every other endpoint — including the backend state-machine
    // reporting endpoint at /positions/:id/recover-funds — is offline.
    // The orchestrator should still complete and return a signature.
    return new Response("relayer is offline", { status: 500 });
  }) as typeof globalThis.fetch;
}

// Any base64 string works because `Transaction.from` is stubbed via
// the `@solana/web3.js` mock below — the orchestrator never decodes a
// real transaction in these tests.
const SYNTHETIC_TX_B64 = "QQ==";

// Provide an in-memory localStorage. The test environment's stub
// doesn't expose `removeItem` / `clear`, so we replace it for these
// tests with a real Map-backed shim.
function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

beforeEach(async () => {
  fetchedUrls.length = 0;
  installMemoryLocalStorage();

  globalThis.fetch = offlineRelayerFetch();

  // Wallet provider stub — returns the tx untouched so the broadcast
  // step gets a signable-shaped object.
  (window as unknown as { solana: { signTransaction: typeof signTransactionMock } }).solana = {
    signTransaction: signTransactionMock,
  };

  // Mock the heavy mixer module so we don't run the real ZK prover.
  vi.doMock("../mixer", () => ({
    buildWithdrawCircuitInput: () => ({
      root: "0",
      nullifierHash: "44444",
      recipient: "0",
      relayer: "0",
      fee: "0",
      secret: "11111",
      nullifier: "22222",
      pathElements: [],
      pathIndices: [],
    }),
    createMixerMerkleTree: async (_default: unknown, _leaves: bigint[]) => ({
      root: () => 0n,
      indexOf: () => 0,
      getProof: () => ({ pathElements: [], pathIndices: [] }),
    }),
    generateWithdrawProof: async () => ({
      proof: { pi_a: [], pi_b: [], pi_c: [], protocol: "", curve: "" },
      publicSignals: [],
    }),
    pubkeyToFieldHash: async () => 0n,
    convertProofToBytes: () => new Uint8Array(),
    convertPublicInputsToBytes: () => new Uint8Array(),
    uint8ArrayToBase64: () => "",
  }));

  // Mock the Connection + Transaction.from so we don't talk to a real
  // RPC and don't depend on `@solana/buffer-layout` working in jsdom.
  vi.doMock("@solana/web3.js", async () => {
    const actual = await vi.importActual<typeof import("@solana/web3.js")>(
      "@solana/web3.js",
    );
    class MockTransaction {
      recentBlockhash = "11111111111111111111111111111111";
      serialize() {
        return new Uint8Array();
      }
      static from() {
        return new MockTransaction();
      }
    }
    return {
      ...actual,
      // PublicKey constructor + toBase58 is exercised; keep the real one.
      Transaction: MockTransaction,
      Connection: class {
        async sendRawTransaction() {
          return "user-signed-mixer-withdraw-sig";
        }
        async getLatestBlockhash() {
          return {
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 1,
          };
        }
        async confirmTransaction() {
          return { value: { err: null } };
        }
      },
    };
  });
});

afterEach(() => {
  vi.doUnmock("../mixer");
  vi.doUnmock("@solana/web3.js");
  vi.resetModules();
});

async function signTransactionMock<T>(tx: T): Promise<T> {
  return tx;
}

describe("runUserSignedRecovery — relayer-offline contract", () => {
  it("throws MissingWithdrawWitnessError when the Position has no stored witness", async () => {
    const position = seedStoredPosition("pos_no_witness", false);
    await expect(
      runUserSignedRecovery({
        mainWalletAddress: MAIN_WALLET,
        position,
      }),
    ).rejects.toBeInstanceOf(MissingWithdrawWitnessError);
  });

  it("never hits a /relayer/* endpoint even when those endpoints would return 500", async () => {
    // Re-import the module after the heavy mocks are registered so the
    // dynamic import inside the orchestrator picks up the stubs.
    const { runUserSignedRecovery: runIsolated } = await import("../userSignedRecovery");

    const position = seedStoredPosition("pos_with_witness", true);
    const res = await runIsolated({
      mainWalletAddress: MAIN_WALLET,
      position,
    });

    // Load-bearing assertion #1 — no /relayer/* URL ever fetched.
    for (const url of fetchedUrls) {
      expect(url).not.toMatch(/\/relayer\//);
    }

    // Load-bearing assertion #2 — recovery returned a signature, so
    // the funds-recovery path completed even though the backend
    // reporting endpoint (/positions/:id/recover-funds) 500'd.
    expect(res.signature).toBe("user-signed-mixer-withdraw-sig");
    expect(res.recipient).toBe(MAIN_WALLET);
  });

  it("clears the persisted mixer-withdraw witness after a confirmed recovery", async () => {
    const { runUserSignedRecovery: runIsolated } = await import("../userSignedRecovery");

    const position = seedStoredPosition("pos_clear_witness", true);
    expect(
      listLocalPositions(MAIN_WALLET).find((p) => p.positionId === position.positionId)
        ?.mixerWithdrawWitness,
    ).toBeDefined();

    await runIsolated({ mainWalletAddress: MAIN_WALLET, position });

    expect(
      listLocalPositions(MAIN_WALLET).find((p) => p.positionId === position.positionId)
        ?.mixerWithdrawWitness,
    ).toBeUndefined();
  });

  it("still completes when the backend reporting endpoint /positions/:id/recover-funds returns 500", async () => {
    const { runUserSignedRecovery: runIsolated } = await import("../userSignedRecovery");

    const position = seedStoredPosition("pos_backend_down", true);
    const res = await runIsolated({ mainWalletAddress: MAIN_WALLET, position });

    // Funds are safe even though the state-machine endpoint failed.
    expect(res.signature).toBe("user-signed-mixer-withdraw-sig");

    // The orchestrator made the best-effort POST anyway — verify it
    // tried, so we know the state-flip would happen as soon as the
    // backend comes back online.
    expect(
      fetchedUrls.some((u) => u.includes(`/positions/${position.positionId}/recover-funds`)),
    ).toBe(true);
  });
});
