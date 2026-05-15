/**
 * close/02 — Close confirmation modal contract.
 *
 * Covers the UI behaviours the ticket calls out:
 *   - SOL-only quote (no `swap` field) — slippage step hidden, confirm
 *     enabled immediately
 *   - Pair-with-swap quote — slippage selector visible, presets +
 *     custom input working, min_amount_out preview recomputes
 *     client-side as slippage changes (no extra network call)
 *   - Confirm gated until slippage confirmed (default-not-clicked path
 *     blocks confirm; clicking a preset unblocks it)
 *   - Custom input out-of-range (0.1–5%) renders an error + keeps
 *     confirm disabled
 *
 * Mounts the dialog directly with mocked props — no router, no fetch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import {
  CloseConfirmDialog,
  type CloseQuoteResponse,
} from "../CloseConfirmDialog";

function noSwapQuote(): Extract<CloseQuoteResponse, { closeable: true }> {
  return {
    closeable: true,
    estimate: {
      solLamports: "1234567000",
      otherSideLamports: "0",
      otherSideSymbol: null,
      accruedFeeSolLamports: "0",
      accruedFeeOtherLamports: "0",
    },
    denomination: "1000000000",
    dustLamports: "234567000",
  };
}

function withSwapQuote(): Extract<CloseQuoteResponse, { closeable: true }> {
  return {
    closeable: true,
    estimate: {
      solLamports: "750000000",
      otherSideLamports: "1000000",
      otherSideSymbol: "USDC",
      accruedFeeSolLamports: "0",
      accruedFeeOtherLamports: "0",
    },
    swap: {
      inLamports: "1000000",
      expectedOutLamports: "300000000",
      feeLamports: "900000",
      priceImpact: "0.0089",
    },
    denomination: "1000000000",
    dustLamports: "50000000",
  };
}

describe("close/02 — CloseConfirmDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no-swap quote: hides slippage selector and lets the user confirm immediately", async () => {
    const onConfirm = vi.fn();
    render(
      <CloseConfirmDialog
        open
        onOpenChange={() => {}}
        quote={noSwapQuote()}
        onConfirm={onConfirm}
      />,
    );

    // Estimate section is rendered.
    expect(screen.getByTestId("close-confirm-estimate")).toBeInTheDocument();
    // Slippage selector is hidden — no `close-confirm-slippage` panel.
    expect(screen.queryByTestId("close-confirm-slippage")).toBeNull();

    const submit = screen.getByTestId("close-confirm-submit");
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0]).toEqual({
      slippageBps: 50,
      expectedSwapOutLamports: null,
    });
  });

  it("with-swap quote: renders the slippage selector and the min_amount_out preview", () => {
    render(
      <CloseConfirmDialog
        open
        onOpenChange={() => {}}
        quote={withSwapQuote()}
        onConfirm={() => {}}
      />,
    );

    expect(screen.getByTestId("close-confirm-slippage")).toBeInTheDocument();
    expect(screen.getByTestId("slippage-preset-10")).toBeInTheDocument();
    expect(screen.getByTestId("slippage-preset-50")).toBeInTheDocument();
    expect(screen.getByTestId("slippage-preset-100")).toBeInTheDocument();
    // Default slippage is 50 bps → min = 300_000_000 * 9950 / 10_000 =
    // 298_500_000 lamports = 0.2985 SOL.
    expect(screen.getByTestId("close-confirm-min-out").textContent).toMatch(
      /0\.2985 SOL/,
    );
  });

  it("confirm is gated until the user clicks a preset (default-not-confirmed blocks submit)", async () => {
    const onConfirm = vi.fn();
    render(
      <CloseConfirmDialog
        open
        onOpenChange={() => {}}
        quote={withSwapQuote()}
        onConfirm={onConfirm}
      />,
    );

    const submit = screen.getByTestId("close-confirm-submit");
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByTestId("slippage-preset-50"));
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0]).toEqual({
      slippageBps: 50,
      expectedSwapOutLamports: "300000000",
    });
  });

  it("changing the slippage preset recomputes min_amount_out client-side (no network call)", () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    render(
      <CloseConfirmDialog
        open
        onOpenChange={() => {}}
        quote={withSwapQuote()}
        onConfirm={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId("slippage-preset-100"));
    // 300_000_000 * 9_900 / 10_000 = 297_000_000 lamports = 0.297 SOL
    expect(screen.getByTestId("close-confirm-min-out").textContent).toMatch(
      /0\.297 SOL/,
    );

    fireEvent.click(screen.getByTestId("slippage-preset-10"));
    // 300_000_000 * 9_990 / 10_000 = 299_700_000 lamports = 0.2997 SOL
    expect(screen.getByTestId("close-confirm-min-out").textContent).toMatch(
      /0\.2997 SOL/,
    );

    // Critical: no network call was made for the recompute.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("custom slippage out of range renders an error and keeps confirm disabled", () => {
    render(
      <CloseConfirmDialog
        open
        onOpenChange={() => {}}
        quote={withSwapQuote()}
        onConfirm={() => {}}
      />,
    );

    const customInput = screen.getByTestId("slippage-custom") as HTMLInputElement;
    fireEvent.change(customInput, { target: { value: "5" } }); // <10 → invalid
    expect(screen.getByTestId("close-confirm-slippage-error")).toBeInTheDocument();
    expect(screen.getByTestId("close-confirm-submit")).toBeDisabled();

    fireEvent.change(customInput, { target: { value: "600" } }); // >500 → invalid
    expect(screen.getByTestId("close-confirm-slippage-error")).toBeInTheDocument();
    expect(screen.getByTestId("close-confirm-submit")).toBeDisabled();

    fireEvent.change(customInput, { target: { value: "250" } }); // valid
    expect(screen.queryByTestId("close-confirm-slippage-error")).toBeNull();
    expect(screen.getByTestId("close-confirm-submit")).not.toBeDisabled();
  });

  it("custom slippage value flows through to onConfirm", async () => {
    const onConfirm = vi.fn();
    render(
      <CloseConfirmDialog
        open
        onOpenChange={() => {}}
        quote={withSwapQuote()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.change(screen.getByTestId("slippage-custom"), {
      target: { value: "150" },
    });
    fireEvent.click(screen.getByTestId("close-confirm-submit"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].slippageBps).toBe(150);
  });
});
