/**
 * Tests for close/03's user-signed close-recovery orchestrator
 * (`runUserSignedCloseRecovery`).
 *
 * Load-bearing assertion (per ticket AC + ADR-0004 mirroring dust/04
 * for Flow 3):
 *   "Forces `/relayer/*` and `/positions/:id/close-recover` to 500;
 *    recovery still completes and the witness is cleared."
 *
 * Concretely we assert:
 *   1. `MissingCloseWitnessError` is thrown when no close witness is
 *      stored on the Position. The caller then falls back to the
 *      legacy stealth-sweep UI (same caveat dust/04 carries).
 *   2. The orchestrator never touches a `/relayer/*` endpoint, even
 *      when those endpoints would 500 on every hit.
 *   3. The close witness is cleared from localStorage after a
 *      confirmed recovery — same single-use nullifier discipline
 *      dust/04 enforces for the mixer-withdraw witness.
 *   4. The orchestrator still completes when the backend reporting
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
    });
  }

  return listLocalPositions(MAIN_WALLET).find((p) => p.positionId === positionId)!;
}

// Track every fetch URL the orchestrator hits so we can assert it
// never touches a relayer endpoint.
const fetchedUrls: string[] = [];

/**
 * fetch stub that 500s on every URL. Models the worst-case "relayer
 * is offline AND the close-recover reporting endpoint is offline"
 * scenario from the ticket AC. The orchestrator must still complete.
 */
function alwaysFailingFetch(): typeof globalThis.fetch {
  return (async (url: RequestInfo | URL) => {
    const u = typeof url === "string" ? url : url.toString();
    fetchedUrls.push(u);
    return new Response("relayer / backend offline", { status: 500 });
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
  installMemoryLocalStorage();
  globalThis.fetch = alwaysFailingFetch();

  // Wallet provider stub — signing isn't exercised in this slice's
  // recovery paths but the orchestrator imports the signer factory.
  (window as unknown as { solana: { signTransaction: typeof signTransactionMock } }).solana = {
    signTransaction: signTransactionMock,
  };

  // Mock @solana/web3.js Connection so we don't talk to a real RPC.
  vi.doMock("@solana/web3.js", async () => {
    const actual = await vi.importActual<typeof import("@solana/web3.js")>(
      "@solana/web3.js",
    );
    return {
      ...actual,
      Connection: class {
        async getLatestBlockhash() {
          return {
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 1,
          };
        }
      },
    };
  });
});

afterEach(() => {
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

  it("never hits a /relayer/* endpoint even when fetch 500s everywhere (bail-to-withdrawn)", async () => {
    const { runUserSignedCloseRecovery: runIsolated } = await import(
      "../userSignedCloseRecovery"
    );

    const position = seedStoredPosition("pos_bail_offline", true);
    const res = await runIsolated({
      mainWalletAddress: MAIN_WALLET,
      position,
      recoveryAction: "bail-to-withdrawn",
    });

    // Load-bearing assertion #1 — no `/relayer/*` URL ever fetched.
    for (const url of fetchedUrls) {
      expect(url).not.toMatch(/\/relayer\//);
    }

    // Load-bearing assertion #2 — orchestrator completed even though
    // the reporting endpoint 500'd. Funds are safe.
    expect(res.finalState).toBe("WITHDRAWN");
  });

  it("never hits a /relayer/* endpoint even when fetch 500s everywhere (complete-close)", async () => {
    const { runUserSignedCloseRecovery: runIsolated } = await import(
      "../userSignedCloseRecovery"
    );

    const position = seedStoredPosition("pos_complete_offline", true);
    const res = await runIsolated({
      mainWalletAddress: MAIN_WALLET,
      position,
      recoveryAction: "complete-close",
    });

    for (const url of fetchedUrls) {
      expect(url).not.toMatch(/\/relayer\//);
    }
    expect(res.finalState).toBe("CLOSED");
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

  it("still completes when the backend reporting endpoint returns 500 (best-effort POST)", async () => {
    const { runUserSignedCloseRecovery: runIsolated } = await import(
      "../userSignedCloseRecovery"
    );

    const position = seedStoredPosition("pos_backend_down", true);
    const res = await runIsolated({
      mainWalletAddress: MAIN_WALLET,
      position,
      recoveryAction: "bail-to-withdrawn",
    });

    // Funds are safe even though the state-machine endpoint failed.
    expect(res.finalState).toBe("WITHDRAWN");

    // Orchestrator made the best-effort POST anyway — verify it
    // tried, so we know the state-flip would happen as soon as the
    // backend comes back online.
    expect(
      fetchedUrls.some((u) =>
        u.includes(`/positions/${position.positionId}/close-recover`),
      ),
    ).toBe(true);
  });
});
