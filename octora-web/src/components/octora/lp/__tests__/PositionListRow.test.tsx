/**
 * PositionListRow — Position-list row in the portfolio. Tests cover the
 * "v2" un-closeable badge added under ticket 04: it must render only
 * when the close-quote endpoint reports `closeable: false`, and must
 * stay hidden for closed rows, recovery rows, and rows where the API
 * doesn't know (closeable: null).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { PositionListRow } from "../PositionListRow";
import type { PortfolioPosition } from "@/components/octora/types";

function mockJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function basePosition(overrides: Partial<PortfolioPosition> = {}): PortfolioPosition {
  return {
    id: "pos-1",
    poolAddress: "Pool111111111111111111111111111111111111111",
    poolName: "SOL/USDC",
    protocol: "Meteora DLMM",
    deposited: "$100.00",
    value: "$100.00",
    feesEarned: "$0.00",
    apr: "10%",
    status: "Active",
    inRange: true,
    ...overrides,
  };
}

function renderRow(position: PortfolioPosition) {
  return render(
    <MemoryRouter>
      <PositionListRow position={position} />
    </MemoryRouter>,
  );
}

describe("PositionListRow — un-closeable badge", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  it("renders the v2 badge when the close-quote endpoint reports closeable:false", async () => {
    fetchSpy!.mockResolvedValueOnce(
      mockJsonResponse(200, {
        closeable: false,
        reason: "unsupported_mint",
        details: { mint: "MintMintMint11111111111111111111111111111111", extension: "TransferHook" },
      }),
    );

    renderRow(basePosition());

    const badge = await screen.findByTestId("unclosable-position-badge");
    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute("title")).toContain("TransferHook");
    expect(badge.textContent?.toLowerCase()).toContain("v2");
  });

  it("does not render the badge when the API green-lights the close", async () => {
    fetchSpy!.mockResolvedValueOnce(mockJsonResponse(200, { closeable: true }));

    renderRow(basePosition());

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(screen.queryByTestId("unclosable-position-badge")).not.toBeInTheDocument();
  });

  it("does not render the badge when the close-quote endpoint is missing (404)", async () => {
    fetchSpy!.mockResolvedValueOnce(mockJsonResponse(404, { error: "not found" }));

    renderRow(basePosition());

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(screen.queryByTestId("unclosable-position-badge")).not.toBeInTheDocument();
  });

  it("does not probe close-quote (and renders no badge) for closed positions", async () => {
    renderRow(basePosition({ closed: true, status: "Closed · awaiting sweep" }));

    // Give the effect a chance to fire if it were going to.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("unclosable-position-badge")).not.toBeInTheDocument();
  });

  it("does not probe close-quote for PARKED / LP_FAILED rows", async () => {
    renderRow(basePosition({ status: "PARKED" }));

    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("unclosable-position-badge")).not.toBeInTheDocument();
  });
});
