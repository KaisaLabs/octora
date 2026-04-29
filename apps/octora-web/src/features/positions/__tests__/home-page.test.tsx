import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppRouter } from "@/app/router";

describe("Octora product shell", () => {
  it("creates a private add-liquidity position and shows activity", async () => {
    const user = userEvent.setup();

    render(<AppRouter />);

    await user.type(screen.getByLabelText(/amount/i), "1.25");
    await user.selectOptions(screen.getByLabelText(/pool/i), "sol-usdc");
    await user.click(screen.getByLabelText(/fast private/i));
    await user.click(screen.getByRole("button", { name: /create position/i }));

    expect(await screen.findByRole("heading", { name: /active position/i })).toBeTruthy();
    expect(screen.getByText(/1.25 sol/i)).toBeTruthy();
    expect((screen.getByRole("radio", { name: /fast private/i }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/position is live/i)).toBeTruthy();
    expect(screen.getByText(/intent received/i)).toBeTruthy();
  });
});
