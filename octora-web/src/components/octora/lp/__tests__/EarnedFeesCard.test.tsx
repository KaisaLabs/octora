/**
 * EarnedFeesCard (close/05) — frontend coverage.
 *
 * Asserts:
 *   - Renders only when the Position is `active`.
 *   - Claim button is enabled when accrued fees clear the display
 *     threshold; disabled otherwise.
 *   - After a successful claim, the post-claim panel shows received
 *     SOL + non-SOL residual; Re-mix offer activates only when SOL ≥
 *     one Mixer denomination; Leave-it surfaces the disclosure copy.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { EarnedFeesCard } from "../EarnedFeesCard";
import type { PortfolioPosition } from "@/components/octora/types";

// Mock the wallet provider so the component can assert "wallet
// connected" without standing up the real SolanaProvider tree.
vi.mock("@/providers/SolanaProvider", () => ({
  useSolana: () => ({
    wallet: {
      address: "11111111111111111111111111111111",
      connected: true,
      connecting: false,
      providerId: null,
    },
  }),
}));

// Mock the API surface so we don't fan out to fetch.
const claimMock = vi.fn();
const remixMock = vi.fn();
vi.mock("@/lib/api", () => ({
  claimMidPositionFees: (...args: unknown[]) => claimMock(...args),
  remixClaimedFees: (...args: unknown[]) => remixMock(...args),
}));

function basePosition(overrides: Partial<PortfolioPosition> = {}): PortfolioPosition {
  return {
    id: "pos-1",
    poolAddress: "Pool111111111111111111111111111111111111111",
    poolName: "SOL/USDC",
    protocol: "Meteora DLMM",
    deposited: "$100.00",
    value: "$110.00",
    feesEarned: "$1.50",
    feesUsd: 1.5,
    apr: "10%",
    status: "active",
    inRange: true,
    hasClaimableFees: true,
    ...overrides,
  };
}

describe("EarnedFeesCard — render gating + claim button rules", () => {
  beforeEach(() => {
    claimMock.mockReset();
    remixMock.mockReset();
  });

  it("does not render when the Position is not active", () => {
    render(
      <EarnedFeesCard
        position={basePosition({ status: "PARKED" })}
        positionState="PARKED"
      />,
    );
    expect(screen.queryByTestId("earned-fees-card")).not.toBeInTheDocument();
  });

  it("renders with an enabled Claim button when fees clear the display threshold", () => {
    render(<EarnedFeesCard position={basePosition()} />);
    const btn = screen.getByTestId("earned-fees-claim-button");
    expect(btn).toBeInTheDocument();
    expect(btn).toBeEnabled();
  });

  it("disables the Claim button when fees are below the display threshold", () => {
    render(
      <EarnedFeesCard
        position={basePosition({ feesUsd: 0.001, hasClaimableFees: false })}
      />,
    );
    const btn = screen.getByTestId("earned-fees-claim-button");
    expect(btn).toBeDisabled();
  });

  it("re-mix offer is enabled only when SOL portion ≥ one denomination", async () => {
    // Mock the claim — claimedSolLamports = 250_000_000 (0.25 SOL), well
    // above the 0.1 SOL default Mixer denom, so the Re-mix offer must
    // activate after the claim lands.
    claimMock.mockResolvedValueOnce({
      position: { id: "pos-1", state: "active", statusLabel: "Position active" },
      session: { state: "active" },
      claimedSolLamports: "250000000",
      claimedOtherLamports: "0",
      claimedOtherMintSymbol: null,
      signature: "mock-sig-1",
      activity: [],
    });

    render(<EarnedFeesCard position={basePosition()} />);

    fireEvent.click(screen.getByTestId("earned-fees-claim-button"));

    const remixBtn = await screen.findByTestId("earned-fees-remix-button");
    expect(remixBtn).toBeEnabled();
    const remixOffer = screen.getByTestId("earned-fees-remix-offer");
    expect(remixOffer.getAttribute("data-active")).toBe("true");
  });

  it("re-mix offer is disabled when SOL portion is below one denomination", async () => {
    // 0.05 SOL claimed, default denom is 0.1 SOL — Re-mix button must
    // be disabled with the sub-denom copy surfaced.
    claimMock.mockResolvedValueOnce({
      position: { id: "pos-1", state: "active", statusLabel: "Position active" },
      session: { state: "active" },
      claimedSolLamports: "50000000",
      claimedOtherLamports: "0",
      claimedOtherMintSymbol: null,
      signature: "mock-sig-2",
      activity: [],
    });

    render(<EarnedFeesCard position={basePosition()} />);

    fireEvent.click(screen.getByTestId("earned-fees-claim-button"));

    const remixBtn = await screen.findByTestId("earned-fees-remix-button");
    expect(remixBtn).toBeDisabled();
    const remixOffer = screen.getByTestId("earned-fees-remix-offer");
    expect(remixOffer.getAttribute("data-active")).toBe("false");
  });

  it("Leave-it surfaces the stealth disclosure copy", async () => {
    claimMock.mockResolvedValueOnce({
      position: { id: "pos-1", state: "active", statusLabel: "Position active" },
      session: { state: "active" },
      claimedSolLamports: "150000000",
      claimedOtherLamports: "1200",
      claimedOtherMintSymbol: "USDC",
      signature: "mock-sig-3",
      activity: [],
    });

    render(<EarnedFeesCard position={basePosition()} />);

    fireEvent.click(screen.getByTestId("earned-fees-claim-button"));

    const disclosure = await screen.findByTestId("earned-fees-leave-it-disclosure");
    expect(disclosure.textContent).toContain(
      "Fees will sit in your Stealth Wallet until you re-mix or full-close.",
    );
  });

  it("calls the remix API with the configured denomination when the user clicks Re-mix", async () => {
    claimMock.mockResolvedValueOnce({
      position: { id: "pos-1", state: "active", statusLabel: "Position active" },
      session: { state: "active" },
      claimedSolLamports: "250000000",
      claimedOtherLamports: "0",
      claimedOtherMintSymbol: null,
      signature: "mock-sig-4",
      activity: [],
    });
    remixMock.mockResolvedValueOnce({
      source: "fee-claim",
      remixedLamports: "100000000",
      commitment: null,
      leafIndex: null,
      signature: null,
      position: { id: "pos-1", state: "active" },
      activity: [],
    });

    render(<EarnedFeesCard position={basePosition()} />);
    fireEvent.click(screen.getByTestId("earned-fees-claim-button"));

    const remixBtn = await screen.findByTestId("earned-fees-remix-button");
    fireEvent.click(remixBtn);

    await waitFor(() => expect(remixMock).toHaveBeenCalledTimes(1));
    const [positionId, args] = remixMock.mock.calls[0];
    expect(positionId).toBe("pos-1");
    expect(args.denomLamports).toBe("100000000");
  });
});
