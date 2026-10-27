import {
  Activity,
  AlertTriangle,
  Check,
  CircleDot,
  Plane,
  Radio,
} from "lucide-react";
import type { FlightAnalysis } from "@/lib/contracts";

function formatUtc(value: string) {
  return `${new Date(value).toLocaleString("en-GB", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })} UTC`;
}

function eventLabel(type: string) {
  const labels: Record<string, string> = {
    recording_started: "Recording started",
    recording_completed: "Recording completed",
    recording_interrupted: "Recording interrupted",
    takeoff: "Takeoff transition",
    landing: "Landing transition",
    telemetry_gap: "Telemetry gap",
    route_gap: "Route gap",
  };
  return labels[type] ?? type.replaceAll("_", " ");
}

function eventEvidence(type: string) {
  if (type === "takeoff" || type === "landing") return "OBSERVED TRANSITION";
  if (type.endsWith("_gap")) return "DATA GAP";
  return "RECORDED EVENT";
}

function phaseLabel(value: string) {
  return value.replaceAll("_", " ").toUpperCase();
}

export default function FlightReportTimeline({
  analysis,
}: {
  analysis: FlightAnalysis;
}) {
  const items = [
    ...analysis.events.map((event, index) => ({
      kind: "event" as const,
      key: `event-${event.type}-${event.timestamp}-${index}`,
      at: event.timestamp,
      title: eventLabel(event.type),
      detail: event.details,
      evidence: eventEvidence(event.type),
      confidence: event.confidence,
      icon: event.type.includes("gap")
        ? AlertTriangle
        : event.type === "recording_completed"
          ? Check
          : event.type.startsWith("recording")
            ? Plane
            : Radio,
      endAt: event.endTimestamp,
    })),
    ...analysis.phases.map((phase, index) => ({
      kind: "phase" as const,
      key: `phase-${phase.phase}-${phase.startedAt}-${index}`,
      at: phase.startedAt,
      title: phaseLabel(phase.phase),
      detail: `${Math.floor(phase.durationSeconds / 60)}m ${Math.round(phase.durationSeconds % 60)}s · ${phase.uncertainty ?? "Phase classified from recorded telemetry."}`,
      evidence: "RULE-BASED PHASE",
      confidence: phase.confidence,
      icon: Activity,
      endAt: phase.endedAt,
    })),
  ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));

  return (
    <section
      className="report-section debrief-timeline"
      aria-labelledby="debrief-timeline-title"
    >
      <div className="report-section-heading">
        <div>
          <span className="eyebrow">BACKEND EVENTS & CLASSIFICATION</span>
          <h2 id="debrief-timeline-title">Flight timeline</h2>
        </div>
        <span className="chart-sample-count">
          {items.length.toLocaleString()} RECORDS
        </span>
      </div>
      {items.length === 0 ? (
        <div className="report-empty-inline" role="status">
          <CircleDot size={15} /> No supported events or phase intervals were
          identified.
        </div>
      ) : (
        <ol className="debrief-timeline-list">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <li
                key={item.key}
                className={
                  item.kind === "phase" ? "timeline-phase" : "timeline-event"
                }
              >
                <span className="debrief-item-icon">
                  <Icon size={14} />
                </span>
                <time dateTime={item.at}>{formatUtc(item.at)}</time>
                <div className="debrief-item-copy">
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                  {item.endAt && item.kind === "phase" && (
                    <small>ENDS {formatUtc(item.endAt)}</small>
                  )}
                </div>
                <span className={`evidence-tag evidence-${item.kind}`}>
                  {item.evidence} · {item.confidence.toUpperCase()}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
