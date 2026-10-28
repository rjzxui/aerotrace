import { Activity, Check, CircleDot, Plane, Radio } from "lucide-react";
import type { FlightSession, TelemetrySample } from "@/lib/contracts";

type FlightEvent = {
  at: string;
  title: string;
  detail: string;
  certainty: "RECORDED" | "INFERRED";
  icon: "plane" | "radio" | "activity" | "check";
};

const DEMO_MILESTONES: Array<[number, string, string]> = [
  [2, "Taxi sequence started", "Synthetic ground roll began."],
  [10, "Takeoff", "Synthetic aircraft became airborne."],
  [13, "Climb established", "Aircraft is climbing toward cruise altitude."],
  [34, "Cruise established", "Synthetic aircraft reached cruise."],
  [55, "Descent started", "Synthetic aircraft began descending."],
  [70, "Approach started", "Synthetic aircraft entered final approach."],
  [84, "Landing", "Synthetic aircraft returned to the ground."],
];

function buildEvents(
  session: FlightSession | null,
  samples: TelemetrySample[],
): FlightEvent[] {
  if (!session) return [];
  const events: FlightEvent[] = [];
  const isDemo = session.source === "demo";
  if (session.startedAt) {
    events.push({
      at: session.startedAt,
      title: isDemo ? "Synthetic demo started" : "Flight recording started",
      detail: isDemo
        ? "Generated locally · not connected to MSFS"
        : "Confirmed by the local connector",
      certainty: isDemo ? "INFERRED" : "RECORDED",
      icon: "plane",
    });
  }
  // The dashboard merges persisted and live samples into timestamp order.
  const ordered = samples;
  if (isDemo) {
    for (const [sampleIndex, title, detail] of DEMO_MILESTONES) {
      if (ordered[sampleIndex]) {
        events.push({
          at: ordered[sampleIndex].timestamp,
          title,
          detail,
          certainty: "INFERRED",
          icon: sampleIndex === 84 ? "check" : "activity",
        });
      }
    }
  }
  if (ordered.length > 0) {
    events.push({
      at: ordered[0].timestamp,
      title: isDemo
        ? "First synthetic sample generated"
        : "First telemetry sample received",
      detail:
        ordered[0].quality === "observed"
          ? "Simulator-observed sample"
          : "Synthetic demo sample",
      certainty: isDemo ? "INFERRED" : "RECORDED",
      icon: "radio",
    });
  }
  const firstPosition = ordered.find(
    (sample) => sample.latitudeDeg != null && sample.longitudeDeg != null,
  );
  if (firstPosition) {
    events.push({
      at: firstPosition.timestamp,
      title: isDemo ? "Synthetic position generated" : "Position fix received",
      detail: `${firstPosition.latitudeDeg?.toFixed(4)}°, ${firstPosition.longitudeDeg?.toFixed(4)}°`,
      certainty: isDemo ? "INFERRED" : "RECORDED",
      icon: "activity",
    });
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const gapSeconds =
      (Date.parse(current.timestamp) - Date.parse(previous.timestamp)) / 1000;
    if (gapSeconds > 5 && !isDemo) {
      events.push({
        at: current.timestamp,
        title: "Telemetry gap",
        detail: `${Math.round(gapSeconds)} seconds between received samples`,
        certainty: "INFERRED",
        icon: "radio",
      });
    }
    if (
      !isDemo &&
      previous.onGround != null &&
      current.onGround != null &&
      previous.onGround !== current.onGround
    ) {
      events.push({
        at: current.timestamp,
        title: `On-ground flag changed · ${current.onGround ? "ground" : "airborne"}`,
        detail: isDemo
          ? "Generated synthetic on-ground state"
          : "Based on the telemetry on-ground field",
        certainty: current.quality === "observed" ? "RECORDED" : "INFERRED",
        icon: "activity",
      });
    }
  }
  if (session.completedAt) {
    events.push({
      at: session.completedAt,
      title: "Flight recording completed",
      detail: isDemo
        ? `${session.sampleCount.toLocaleString()} synthetic samples saved in the browser archive`
        : `${session.sampleCount.toLocaleString()} samples confirmed by connector`,
      certainty: "RECORDED",
      icon: "check",
    });
  }
  return events.sort(
    (left, right) => Date.parse(left.at) - Date.parse(right.at),
  );
}

const eventIcons = {
  plane: Plane,
  radio: Radio,
  activity: Activity,
  check: Check,
};

export default function EventTimeline({
  session,
  samples,
}: {
  session: FlightSession | null;
  samples: TelemetrySample[];
}) {
  const events = buildEvents(session, samples);
  return (
    <section className="timeline-section" aria-labelledby="timeline-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">SESSION RECORD</span>
          <h2 id="timeline-title">Flight timeline</h2>
        </div>
        <span className="chart-sample-count">{events.length} EVENTS</span>
      </div>
      {events.length === 0 ? (
        <div className="timeline-empty" role="status">
          <CircleDot size={15} />
          <span>
            {session?.source === "demo"
              ? "Events will appear as the selected provider records a flight."
              : "Events will appear after recording begins."}
          </span>
        </div>
      ) : (
        <ol className="timeline-list">
          {events.map((event, index) => {
            const Icon = eventIcons[event.icon];
            return (
              <li key={`${event.at}-${event.title}-${index}`}>
                <span className="timeline-icon">
                  <Icon size={14} />
                </span>
                <time dateTime={event.at}>
                  {new Date(event.at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </time>
                <div className="timeline-copy">
                  <strong>{event.title}</strong>
                  <span>{event.detail}</span>
                </div>
                <span
                  className={`event-certainty ${event.certainty === "INFERRED" ? "is-inferred" : ""}`}
                >
                  {event.certainty}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
