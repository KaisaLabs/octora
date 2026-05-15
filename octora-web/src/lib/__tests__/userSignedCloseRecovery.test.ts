/**
 * Tests for close/03 + close/06's user-signed close-recovery
 * orchestrator (`runUserSignedCloseRecovery`).
 *
 * Load-bearing assertions:
 *   1. `MissingCloseWitnessError` is thrown when no close witness is
 *      stored on the Position. The caller falls back to the legacy
 *      stealth-sweep UI in that case.
 *   2. The orchestrator never touches a `/relayer/*` endpoint, even
 *      when those endpoints would 500 on every hit (close/03
 *      contract).
 *   3. `runBailToWithdrawn` derives the stealth keypair, builds + sends
 *      a transfer tx to the user's recipient, and returns a signature
 *      (close/06 — vertical-slice stub upgraded to a real sweep).
 *   4. `runCompleteClose` hits `/positions/:id/close-builder` per leg,
 *      stealth-signs each tx, broadcasts, and never touches
 *      `/relayer/*`.
 *   5. `closeWitness` is cleared after a confirmed recovery — same
 *      single-use-nullifier discipline dust/04 enforces.
 *   6. The orchestrator still completes when the backend reporting
 *      endpoint `/positions/:id/close-recover` returns 500.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MissingCloseWitnessError,
  runUserSignedCloseRecovery,
} from "../userSignedCloseRecovery";
import {
  listLocalPositions,
  recordCloseWitness,
  type StoredPosition,
} from "../localPositions";

const MAIN_WALLET = "11111111111111111111111111111111";
const POOL_ADDRESS = "So11111111111111111111111111111111111111112";
const STEALTH_PUBKEY = "11111111111111111111111111111112";

function seedStoredPosition(
  positionId: string,
  withWitness: boolean,
  witnessOverrides?: Partial<NonNullable<StoredPosition["closeWitness"]>>,
): StoredPosition {
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
    lifecycleStatus: "WITHDRAWN",
  };

  window.localStorage.setItem(
    `octora.positions.v1.${MAIN_WALLET}`,
    JSON.stringify([base]),
  );

  if (withWitness) {
    recordCloseWitness(MAIN_WALLET, positionId, {
      poolAddress: POOL_ADDRESS,
      stealthPubkey: POOL_ADDRESS,
      positionPubkey: POOL_ADDRESS,
      denominationLamports: "1000000000",
      expectedSolLamports: "500000000",
      expectedOtherSideLamports: "0",
      ts: 0,
      ...witnessOverrides,
    });
  }

  return listLocalPositions(MAIN_WALLET).find((p) => p.positionId === positionId)!;
}

// Track every fetch URL the orchestrator hits so we can assert it
// never touches a relayer endpoint, AND that it hits the close-builder
// once per leg in the complete-close path.
const fetchedUrls: string[] = [];
const fetchedBodies: Array<{ url: string; body: unknown }> = [];

interface FetchOverrides {
  /**
   * Endpoints to 500 on. By default `/positions/:id/close-recover`
   * 500s so we exercise the best-effort-POST swallow path.
   */
  fail500?: (url: string) => boolean;
  /** Bypass the close-builder 200 response to inject a 501. */
  builder501?: boolean;
}

const SYNTHETIC_TX_B64 = "QQ=="; // any base64 — Transaction.from is mocked.

function makeFetch(overrides: FetchOverrides = {}): typeof globalThis.fetch {
  const shouldFail = overrides.fail500 ?? ((u: string) => u.includes("/close-recover"));
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    fetchedUrls.push(u);
    let parsedBody: unknown = undefined;
    if (init?.body && typeof init.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    fetchedBodies.push({ url: u, body: parsedBody });

    if (u.includes("/close-builder")) {
      if (overrides.builder501) {
        return new Response("close-builder unwired", { status: 501 });
      }
      return new Response(
        JSON.stringify({ transaction: SYNTHETIC_TX_B64, leg: "withdraw-close" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (shouldFail(u)) {
      return new Response("backend offline", { status: 500 });
    }
    return new Response("ok", { status: 200 });
  }) as typeof globalThis.fetch;
}

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

beforeEach(() => {
  fetchedUrls.length = 0;
  fetchedBodies.length = 0;
  installMemoryLocalStorage();
  globalThis.fetch = makeFetch();

  (window as unknown as { solana: { signTransaction: typeof signTransactionMock } }).solana =
    {
      signTransaction: signTransactionMock,
    };

  // Stub the stealth-derivation module — never popping a real wallet.
  vi.doMock("../stealthVault", () => ({
    deriveStealthForPosition: vi.fn(async () => ({
      keypair: {
        publicKey: { toBase58: () => STEALTH_PUBKEY },
        secretKey: new Uint8Array(64),
      },
      publicKey: STEALTH_PUBKEY,
    })),
    deriveStealthForPool: vi.fn(async () => ({
      keypair: {
        publicKey: { toBase58: () => STEALTH_PUBKEY },
        secretKey: new Uint8Array(64),
      },
      publicKey: STEALTH_PUBKEY,
    })),
    clearStealthCache: vi.fn(),
  }));

  // Stub privateLifecycle's executeStealthSweep — bail path calls it
  // and we don't want a real RPC round-trip.
  vi.doMock("../privateLifecycle", () => ({
    executeStealthSweep: vi.fn(async () => ({
      signature: "user-signed-bail-sweep-sig",
      recipient: MAIN_WALLET,
      sweptLamports: "990000000",
      remainingLamports: "5000",
      stealthPubkey: STEALTH_PUBKEY,
    })),
  }));

  // Mock @solana/web3.js — Transaction.from / Connection.sendRawTransaction.
  vi.doMock("@solana/web3.js", async () => {
    const actual = await vi.importActual<typeof import("@solana/web3.js")>(
      "@solana/web3.js",
    );
    class MockTransaction {
      recentBlockhash = "11111111111111111111111111111111";
      serialize() {
        return new Uint8Array();
      }
      partialSign() {
        return this;
      }
      static from() {
        return new MockTransaction();
      }
    }
    return {
      ...actual,
      Transaction: MockTransaction,
      Connection: class {
        async sendRawTransaction() {
          return "user-signed-close-builder-sig";
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
  vi.doUnmock("../stealthVault");
  vi.doUnmock("../privateLifecycle");
  vi.doUnmock("@solana/web3.js");
  vi.resetModules();
});

async function signTransactionMock<T>(tx: T): Promise<T> {
  return tx;
}

describe("runUserSignedCloseRecovery — relayer-offline contract", () => {
  it("throws MissingCloseWitnessError when the Position has no stored close witness", async () => {
    const position = seedStoredPosition("pos_no_witness", false);
    await expect(
      runUserSignedCloseRecovery({
        mainWalletAddress: MAIN_WALLET,
        position,
        recoveryAction: "bail-to-withdrawn",
      }),
    ).rejects.toBeInstanceOf(MissingCloseWitnessError);
  });

  it("bail-to-withdrawn: derives stealth, sweeps, never hits /relayer/*", async () => {
    const { runUserSignedCloseRecovery: runIsolated } = await import(
      "../userSignedCloseRecovery"
    );

    const position = seedStoredPosition("pos_bail_offline", true);
    const res = await runIsolated({
      mainWalletAddress: MAIN_WALLET,
      position,
      recoveryAction: "bail-to-withdrawn",
    });

    for (const url of fetchedUrls) {
      expect(url).not.toMatch(/\/relayer\//);
    }
    expect(res.finalState).toBe("WITHDRAWN");
    expect(res.signature).toBe("user-signed-bail-sweep-sig");
    expect(res.signatures).toEqual(["user-signed-bail-sweep-sig"]);
    expect(res.recipient).toBe(MAIN_WALLET);
  });

  it("complete-close from CLOSE_FAILED: hits /close-builder per leg, never /relayer/*", async () => {
    const { runUserSignedCloseRecovery: runIsolated } = await import(
      "../userSignedCloseRecovery"
    );

    const position = seedStoredPosition("pos_complete_close_failed", true, {
      expectedOtherSideLamports: "0", // single-sided SOL — skip swap leg
    });
    const res = await runIsolated({
      mainWalletAddress: MAIN_WALLET,
      position,
      recoveryAction: "complete-close",
      failedState: "CLOSE_FAILED",
    });

    for (const url of fetchedUrls) {
      expect(url).not.toMatch(/\/relayer\//);
    }
    expect(res.finalState).toBe("CLOSED");
    // CLOSE_FAILED + no swap → 2 builder calls (withdraw-close, mixer-deposit).
    const builderHits = fetchedUrls.filter((u) => u.includes("/close-builder"));
    expect(builderHits.length).toBe(2);
    // Final close-recover POST surfaces the last signature.
    expect(res.signatures.length).toBe(2);
    expect(res.signature).toBe("user-signed-close-builder-sig");
  });

  it("complete-close from SWAP_FAILED: signs swap + mixer-deposit; threads slippage from witness", async () => {
    const { runUserSignedCloseRecovery: runIsolated } = await import(
      "../userSignedCloseRecovery"
    );

    const position = seedStoredPosition("pos_complete_swap_failed", true, {
      slippageBps: 75,
      expectedSwapOutLamports: "500000000",
      expectedOtherSideLamports: "10000000",
    });
    const res = await runIsolated({
      mainWalletAddress: MAIN_WALLET,
      position,
      recoveryAction: "complete-close",
      failedState: "SWAP_FAILED",
    });

    expect(res.finalState).toBe("CLOSED");
    const builderHits = fetchedBodies.filter((f) => f.url.includes("/close-builder"));
    // SWAP_FAILED → swap leg + mixer-deposit leg.
    expect(builderHits.length).toBe(2);
    const swapBody = builderHits[0].body as {
      leg: string;
      slippageBps?: number;
      expectedSwapOutLamports?: string;
    };
    expect(swapBody.leg).toBe("swap");
    expect(swapBody.slippageBps).toBe(75);
    expect(swapBody.expectedSwapOutLamports).toBe("500000000");
  });

  it("complete-close from REMIX_FAILED: signs only the mixer-deposit leg", async () => {
    const { runUserSignedCloseRecovery: runIsolated } = await import(
      "../userSignedCloseRecovery"
    );

    const position = seedStoredPosition("pos_complete_remix_failed", true);
    const res = await runIsolated({
      mainWalletAddress: MAIN_WALLET,
      position,
      recoveryAction: "complete-close",
      failedState: "REMIX_FAILED",
    });

    expect(res.finalState).toBe("CLOSED");
    const builderHits = fetchedBodies.filter((f) => f.url.includes("/close-builder"));
    expect(builderHits.length).toBe(1);
    expect((builderHits[0].body as { leg: string }).leg).toBe("mixer-deposit");
  });

  it("clears the persisted closeWitness after a confirmed recovery", async () => {
    const { runUserSignedCloseRecovery: runIsolated } = await import(
      "../userSignedCloseRecovery"
    );

    const position = seedStoredPosition("pos_clear_witness", true);
    expect(
      listLocalPositions(MAIN_WALLET).find((p) => p.positionId === position.positionId)
        ?.closeWitness,
    ).toBeDefined();

    await runIsolated({
      mainWalletAddress: MAIN_WALLET,
      position,
      recoveryAction: "bail-to-withdrawn",
    });

    expect(
      listLocalPositions(MAIN_WALLET).find((p) => p.positionId === position.positionId)
        ?.closeWitness,
    ).toBeUndefined();
  });

  it("still completes when /close-recover returns 500 (best-effort POST)", async () => {
    const { runUserSignedCloseRecovery: runIsolated } = await import(
      "../userSignedCloseRecovery"
    );

    const position = seedStoredPosition("pos_backend_down", true);
    const res = await runIsolated({
      mainWalletAddress: MAIN_WALLET,
      position,
      recoveryAction: "bail-to-withdrawn",
    });

    expect(res.finalState).toBe("WITHDRAWN");
    expect(
      fetchedUrls.some((u) =>
        u.includes(`/positions/${position.positionId}/close-recover`),
      ),
    ).toBe(true);
  });

  it("complete-close: still completes even when fetch 500s on /close-recover at the end", async () => {
    const { runUserSignedCloseRecovery: runIsolated } = await import(
      "../userSignedCloseRecovery"
    );

    const position = seedStoredPosition("pos_complete_backend_down", true, {
      expectedOtherSideLamports: "0",
    });
    const res = await runIsolated({
      mainWalletAddress: MAIN_WALLET,
      position,
      recoveryAction: "complete-close",
      failedState: "REMIX_FAILED",
    });

    for (const url of fetchedUrls) {
      expect(url).not.toMatch(/\/relayer\//);
    }
    expect(res.finalState).toBe("CLOSED");
  });
});
