import type { ActivityRecord } from "@octora/domain";

interface ActivityTimelineProps {
  activity: ActivityRecord[];
}

export function ActivityTimeline({ activity }: ActivityTimelineProps) {
  return (
    <section className="card">
      <div className="card-heading">
        <h2>Activity</h2>
        <p>Track what happened after your submission.</p>
      </div>

      {activity.length > 0 ? (
        <ol className="timeline">
          {activity.map((item) => (
            <li key={item.id} className="timeline-item">
              <div>
                <p className="timeline-headline">{item.headline}</p>
                <p className="timeline-detail">{item.detail}</p>
              </div>
              <span className="timeline-state">{formatState(item.state)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="empty-state">No activity yet. Submit a position to start the timeline.</p>
      )}
    </section>
  );
}

function formatState(state: ActivityRecord["state"]) {
  if (state === "awaiting_signature") return "Waiting";
  if (state === "active") return "Active";
  return "In progress";
}
