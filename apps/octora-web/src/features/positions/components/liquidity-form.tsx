import { useState, type FormEvent } from "react";
import type { ExecutionMode } from "@octora/domain";
import type { SubmitLiquidityInput } from "@/lib/api";

interface LiquidityFormProps {
  onSubmit: (input: SubmitLiquidityInput) => Promise<void>;
}

export function LiquidityForm({ onSubmit }: LiquidityFormProps) {
  const [amount, setAmount] = useState("");
  const [pool, setPool] = useState("sol-usdc");
  const [mode, setMode] = useState<ExecutionMode>("fast-private");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    await onSubmit({ amount, pool, mode });
    setIsSubmitting(false);
  }

  return (
    <form className="card form-card" onSubmit={handleSubmit}>
      <div className="card-heading">
        <h2>Create position</h2>
        <p>Choose a pool, set the amount, and pick how the position should move.</p>
      </div>

      <label className="field">
        <span>Amount</span>
        <input
          aria-label="Amount"
          inputMode="decimal"
          name="amount"
          onChange={(event) => setAmount(event.target.value)}
          placeholder="1.00"
          type="text"
          value={amount}
        />
      </label>

      <label className="field">
        <span>Pool</span>
        <select aria-label="Pool" name="pool" onChange={(event) => setPool(event.target.value)} value={pool}>
          <option value="sol-usdc">SOL / USDC</option>
        </select>
      </label>

      <fieldset className="field">
        <legend>Mode</legend>
        <label className="mode-option">
          <input
            checked={mode === "standard"}
            name="mode"
            onChange={() => setMode("standard")}
            type="radio"
            value="standard"
          />
          <span>
            <strong>Standard</strong>
            <small>Simple and direct.</small>
          </span>
        </label>
        <label className="mode-option">
          <input
            checked={mode === "fast-private"}
            name="mode"
            onChange={() => setMode("fast-private")}
            type="radio"
            value="fast-private"
          />
          <span>
            <strong>Fast Private</strong>
            <small>Keeps the flow quiet and quick.</small>
          </span>
        </label>
      </fieldset>

      <button className="primary-button" disabled={isSubmitting} type="submit">
        {isSubmitting ? "Creating position..." : "Create position"}
      </button>
    </form>
  );
}
