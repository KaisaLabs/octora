/**
 * useCanClosePosition — drives both the Close button's disabled state
 * (ticket 01 wires it in) and the Position list-row "v2" badge.
 *
 * Covered:
 *   - returns `closeable: true` when the API green-lights the close
 *   - returns `closeable: false` + reason/extension/mint when the API
 *     returns the documented `{ closeable: false, reason, details }` shape
 *   - 404 (close-quote endpoint not yet deployed) -> `closeable: null`
 *     (graceful degrade, not a false negative)
 *   - network error -> `closeable: null`
 *   - null/empty positionId -> immediate `closeable: null` (no fetch)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { useCanClosePosition } from "../useCanClosePosition";

function mockJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("useCanClosePosition", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  it("returns closeable:true when backend green-lights the close", async () => {
    fetchSpy!.mockResolvedValueOnce(mockJsonResponse(200, { closeable: true }));

    const { result } = renderHook(() => useCanClosePosition("pos-1"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.closeable).toBe(true);
    expect(result.current.reason).toBeNull();
    expect(result.current.extension).toBeNull();
  });

  it("returns blocked details when the backend says unsupported_mint / TransferHook", async () => {
    fetchSpy!.mockResolvedValueOnce(
      mockJsonResponse(200, {
        closeable: false,
        reason: "unsupported_mint",
        details: { mint: "MintMintMint11111111111111111111111111111111", extension: "TransferHook" },
      }),
    );

    const { result } = renderHook(() => useCanClosePosition("pos-1"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.closeable).toBe(false);
    expect(result.current.reason).toBe("unsupported_mint");
    expect(result.current.extension).toBe("TransferHook");
    expect(result.current.mint).toBe("MintMintMint11111111111111111111111111111111");
  });

  it("degrades to closeable:null when the close-quote endpoint is missing (404)", async () => {
    // Ticket 02 hasn't shipped yet — landing the row badge in a release
    // before close-quote should not paint every row as un-closeable.
    fetchSpy!.mockResolvedValueOnce(mockJsonResponse(404, { error: "not found" }));

    const { result } = renderHook(() => useCanClosePosition("pos-1"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.closeable).toBeNull();
  });

  it("degrades to closeable:null on network errors", async () => {
    fetchSpy!.mockRejectedValueOnce(new Error("offline"));

    const { result } = renderHook(() => useCanClosePosition("pos-1"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.closeable).toBeNull();
  });

  it("does not fetch and reports closeable:null when positionId is null", async () => {
    const { result } = renderHook(() => useCanClosePosition(null));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.closeable).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
