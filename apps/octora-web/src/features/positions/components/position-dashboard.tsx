import type { ActivePositionView } from "@/lib/api";

interface PositionDashboardProps {
  position: ActivePositionView | null;
}

export function PositionDashboard({ position }: PositionDashboardProps) {
  return (
    <section className="card">
      <div className="card-heading">
        <h2>Active position</h2>
        <p>See the position that was created from your latest submission.</p>
      </div>

      {position ? (
        <dl className="position-grid">
          <div>
            <dt>Pool</dt>
            <dd>{position.poolLabel}</dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>{position.amountLabel}</dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>{position.modeLabel}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{position.statusLabel}</dd>
          </div>
        </dl>
      ) : (
        <p className="empty-state">No active position yet. Create one to see it here.</p>
      )}
    </section>
  );
}
