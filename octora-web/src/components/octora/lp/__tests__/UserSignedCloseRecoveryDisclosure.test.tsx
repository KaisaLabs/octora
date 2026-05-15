/**
 * Tests for `UserSignedCloseRecoveryDisclosure` — the close/03
 * pre-sign disclosure component. Pins the load-bearing copy + ack
 * gate behaviour so future edits don't accidentally drop the
 * linkability warning required by ADR-0002 + ADR-0004 for Flow 3.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { UserSignedCloseRecoveryDisclosure } from "../UserSignedCloseRecoveryDisclosure";

describe("UserSignedCloseRecoveryDisclosure", () => {
  it("renders the complete-close copy with the linkability warning", () => {
    render(
      <UserSignedCloseRecoveryDisclosure
        recoveryAction="complete-close"
        acknowledged={false}
        onAcknowledgedChange={() => {}}
      />,
    );
    expect(
      screen.getByText(/breaks unlinkability for the remaining leg/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/origin wallet will be visibly linked/i),
    ).toBeInTheDocument();
  });

  it("renders the bail-to-withdrawn copy + names the destination", () => {
    render(
      <UserSignedCloseRecoveryDisclosure
        recoveryAction="bail-to-withdrawn"
        acknowledged={false}
        onAcknowledgedChange={() => {}}
        recipient="So11111111111111111111111111111111111111112"
      />,
    );
    expect(
      screen.getByText(/bailing to a direct withdraw breaks unlinkability/i),
    ).toBeInTheDocument();
    // Destination short-form (first 6 + last 4) must appear in the body.
    expect(screen.getByText(/So1111…1112/)).toBeInTheDocument();
  });

  it("fires onAcknowledgedChange when the checkbox toggles", () => {
    const onChange = vi.fn();
    render(
      <UserSignedCloseRecoveryDisclosure
        recoveryAction="complete-close"
        acknowledged={false}
        onAcknowledgedChange={onChange}
      />,
    );
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("falls back to a generic recipient phrase when none is supplied (bail path)", () => {
    render(
      <UserSignedCloseRecoveryDisclosure
        recoveryAction="bail-to-withdrawn"
        acknowledged={false}
        onAcknowledgedChange={() => {}}
      />,
    );
    expect(screen.getByText(/your origin wallet/i)).toBeInTheDocument();
  });
});
