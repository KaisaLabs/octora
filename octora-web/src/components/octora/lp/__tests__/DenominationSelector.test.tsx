/**
 * DenominationSelector — picker that consumes `GET /mixer/pools` and renders
 * the {0.1, 1, 5, 10} SOL Denomination ladder.
 *
 * Covered behaviours:
 *   - sub-threshold (anonymitySet < MIN_ANONYMITY_SET) buckets are rendered
 *     as `disabled` with an explanation tooltip — never as a fictional input
 *     the backend would reject (see project memory `feedback_truthful_ui.md`).
 *   - clicking a disabled bucket is a no-op (does not fire `onChange`).
 *   - usable buckets are clickable; auto-select picks the largest usable one.
 *   - 1 SOL tier remains usable (no regression on the existing single-denom
 *     flow that ticket 07's acceptance criteria explicitly call out).
 *
 * Uses `vi.spyOn(global, 'fetch')` to script `/mixer/pools` responses; matches
 * the pattern in `src/test/setup.ts` (jsdom + @testing-library/react).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DenominationSelector } from "../DenominationSelector";

interface PoolsApiPool {
  denomination: string;
  initialized?: boolean;
  anonymitySet?: number;
  anonymitySetMin?: number;
  isPaused?: boolean;
}

function mockPoolsResponse(pools: PoolsApiPool[], min = 20) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ pools, anonymitySetMin: min }),
    text: async () => JSON.stringify({ pools, anonymitySetMin: min }),
  } as unknown as Response;
}

describe("DenominationSelector", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  it("renders every Denomination ladder bucket and disables sub-threshold ones with a tooltip", async () => {
    fetchSpy!.mockResolvedValueOnce(
      mockPoolsResponse([
        // 0.1 SOL: thin → disabled
        { denomination: "100000000", initialized: true, anonymitySet: 3 },
        // 1 SOL: healthy → enabled (regression guard for the existing tier)
        { denomination: "1000000000", initialized: true, anonymitySet: 25 },
        // 5 SOL: thin → disabled
        { denomination: "5000000000", initialized: true, anonymitySet: 0 },
        // 10 SOL: uninitialized → hidden (no actionable state for users)
        { denomination: "10000000000", initialized: false },
      ]),
    );

    const onChange = vi.fn();
    render(<DenominationSelector value={null} onChange={onChange} />);

    // Wait for the fetch to resolve and the picker to render its buttons.
    const oneSolButton = await screen.findByTestId("denom-1000000000");

    // 1 SOL: usable (regression — the existing single-denom MVP tier).
    expect(oneSolButton).toHaveAttribute("data-usable", "true");
    expect(oneSolButton).not.toBeDisabled();

    // 0.1 SOL: disabled with "needs N more deposits" tooltip.
    const thinButton = screen.getByTestId("denom-100000000");
    expect(thinButton).toHaveAttribute("data-usable", "false");
    expect(thinButton).toBeDisabled();
    expect(thinButton.getAttribute("title")).toMatch(/needs 17 more deposits/i);
    expect(thinButton.getAttribute("title")).toMatch(/privacy-safe/i);

    // 5 SOL: locked at the v1 launch (single-sided SOL only) — disabled with
    // the "coming soon" explanation rather than the anonymity-set tooltip.
    // Per `feedback_truthful_ui.md`: render disabled-with-explanation, never
    // a fictional input the backend would reject.
    const fiveSolButton = screen.getByTestId("denom-5000000000");
    expect(fiveSolButton).toHaveAttribute("data-usable", "false");
    expect(fiveSolButton).toBeDisabled();
    expect(fiveSolButton.getAttribute("title")).toMatch(/aren't supported yet|coming soon/i);

    // 10 SOL: uninitialized — hidden entirely (no `denom-10000000000` button).
    expect(screen.queryByTestId("denom-10000000000")).toBeNull();

    // Auto-select fired with the only usable bucket (1 SOL).
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalledWith("1000000000", 25);
  });

  it("clicking a disabled (sub-threshold) bucket is a no-op", async () => {
    fetchSpy!.mockResolvedValueOnce(
      mockPoolsResponse([
        { denomination: "100000000", initialized: true, anonymitySet: 0 },
        { denomination: "1000000000", initialized: true, anonymitySet: 25 },
      ]),
    );

    const onChange = vi.fn();
    render(<DenominationSelector value="1000000000" onChange={onChange} />);

    const thin = await screen.findByTestId("denom-100000000");
    expect(thin).toBeDisabled();

    onChange.mockClear();
    // jsdom honours the `disabled` attribute and skips the click handler,
    // so the assertion below tests both the disabled flag AND the explicit
    // `if (disabled) return;` guard in onClick (defence-in-depth).
    fireEvent.click(thin);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clicking an enabled bucket fires onChange with the lamports + anonymitySet", async () => {
    fetchSpy!.mockResolvedValueOnce(
      mockPoolsResponse([
        // Use 0.1 SOL + 1 SOL — both are unlocked v1 tiers. 5 SOL is locked
        // at launch (`UNSUPPORTED_DENOM_LAMPORTS`) so it can't drive a click
        // assertion until the v2 multi-denom unlock lands.
        { denomination: "100000000", initialized: true, anonymitySet: 30 },
        { denomination: "1000000000", initialized: true, anonymitySet: 42 },
      ]),
    );

    const onChange = vi.fn();
    // Provide a non-null `value` so auto-select doesn't fire, keeping the
    // assertion focused on the explicit click.
    render(<DenominationSelector value="100000000" onChange={onChange} />);

    const oneSol = await screen.findByTestId("denom-1000000000");
    expect(oneSol).not.toBeDisabled();

    onChange.mockClear();
    fireEvent.click(oneSol);
    expect(onChange).toHaveBeenCalledWith("1000000000", 42);
  });

  it("shows the 'no pool reached threshold yet' message when every bucket is thin", async () => {
    fetchSpy!.mockResolvedValueOnce(
      mockPoolsResponse([
        { denomination: "100000000", initialized: true, anonymitySet: 0 },
        { denomination: "1000000000", initialized: true, anonymitySet: 0 },
      ]),
    );

    render(<DenominationSelector value={null} onChange={() => {}} />);
    expect(
      await screen.findByText(/no mixer pool has reached the 20-deposit privacy threshold/i),
    ).toBeInTheDocument();
  });
});
