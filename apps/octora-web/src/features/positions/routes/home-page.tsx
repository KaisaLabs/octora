import { useState } from "react";
import { submitAddLiquidityIntent, type ActivePositionView, type SubmitLiquidityInput, type SubmitLiquidityResult } from "@/lib/api";
import { ActivityTimeline } from "@/features/positions/components/activity-timeline";
import { LiquidityForm } from "@/features/positions/components/liquidity-form";
import { PositionDashboard } from "@/features/positions/components/position-dashboard";

export function HomePage() {
  const [position, setPosition] = useState<ActivePositionView | null>(null);
  const [activity, setActivity] = useState<SubmitLiquidityResult["activity"]>([]);

  async function handleSubmit(input: SubmitLiquidityInput) {
    const result = await submitAddLiquidityIntent(input);
    setPosition(result.position);
    setActivity(result.activity);
  }

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Octora</p>
        <h1>Private liquidity, without the noise.</h1>
        <p className="lede">
          Set up a position in a few steps, choose how it should move, and keep the experience clean and simple.
        </p>
      </section>

      <section className="workspace" aria-label="Octora workspace">
        <LiquidityForm onSubmit={handleSubmit} />
        <div className="dashboard-stack">
          <PositionDashboard position={position} />
          <ActivityTimeline activity={activity} />
        </div>
      </section>
    </main>
  );
}
