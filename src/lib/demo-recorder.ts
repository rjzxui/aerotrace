import type {
  FlightAnalysis,
  FlightReport,
  FlightSession,
  PhaseInterval,
  TelemetrySample,
} from "./contracts.ts";
import type { FlightReportBundle } from "./flight-api.ts";

export const DEMO_FLIGHT_DURATION_SECONDS = 90;
const METRES_PER_SECOND_PER_KNOT = 1 / 1.94384;
const METRES_PER_SECOND_PER_FPM = 1 / 196.8504;
const DEMO_MILESTONES: Array<[number, string, string]> = [
  [2, "taxi_started", "Synthetic ground roll began."],
  [10, "takeoff", "Synthetic aircraft became airborne."],
  [13, "climb_started", "Aircraft is climbing toward cruise altitude."],
  [34, "cruise_started", "Synthetic aircraft reached cruise."],
  [55, "descent_started", "Synthetic aircraft began descending."],
  [70, "approach_started", "Synthetic aircraft entered final approach."],
  [84, "landing", "Synthetic aircraft returned to the ground."],
];

type DemoPhase =
  | "on_ground"
  | "takeoff_initial_climb"
  | "climb"
  | "cruise"
  | "descent"
  | "approach"
  | "landing_rollout";

const phaseAt = (seconds: number): DemoPhase => {
  if (seconds < 8) return "on_ground";
  if (seconds < 13) return "takeoff_initial_climb";
  if (seconds < 34) return "climb";
  if (seconds < 55) return "cruise";
  if (seconds < 70) return "descent";
  if (seconds < 84) return "approach";
  return "landing_rollout";
};

function interpolate(start: number, end: number, progress: number) {
  const clamped = Math.max(0, Math.min(1, progress));
  return start + (end - start) * clamped;
}

function coordinatesAt(seconds: number): [number, number] {
  const routeProgress =
    seconds < 8
      ? seconds * 0.006
      : seconds < 84
        ? 0.048 + ((seconds - 8) / 76) * 0.91
        : 0.958 + ((seconds - 84) / 6) * 0.042;
  const bend = Math.sin(Math.PI * routeProgress) * 0.035;
  return [
    interpolate(37.6213, 39.4999, routeProgress) + bend,
    interpolate(-122.379, -119.7681, routeProgress) - bend * 0.55,
  ];
}

function flightStateAt(seconds: number) {
  if (seconds < 8) {
    return {
      altitudeM: 0,
      airspeedKt: interpolate(0, 27, seconds / 8),
      verticalSpeedFpm: 0,
      onGround: true,
    };
  }
  if (seconds < 13) {
    const progress = (seconds - 8) / 5;
    return {
      altitudeM: interpolate(0, 105, progress),
      airspeedKt: interpolate(27, 145, progress),
      verticalSpeedFpm: 1_200,
      onGround: seconds < 10,
    };
  }
  if (seconds < 34) {
    const progress = (seconds - 13) / 21;
    return {
      altitudeM: interpolate(105, 5_800, progress),
      airspeedKt: interpolate(145, 245, progress),
      verticalSpeedFpm: 1_600,
      onGround: false,
    };
  }
  if (seconds < 55) {
    return {
      altitudeM: 5_800 + Math.sin(seconds / 4) * 18,
      airspeedKt: 245 + Math.sin(seconds / 5) * 2,
      verticalSpeedFpm: Math.sin(seconds / 3) * 35,
      onGround: false,
    };
  }
  if (seconds < 70) {
    const progress = (seconds - 55) / 15;
    return {
      altitudeM: interpolate(5_800, 720, progress),
      airspeedKt: interpolate(245, 155, progress),
      verticalSpeedFpm: -1_350,
      onGround: false,
    };
  }
  if (seconds < 84) {
    const progress = (seconds - 70) / 14;
    return {
      altitudeM: interpolate(720, 25, progress),
      airspeedKt: interpolate(155, 115, progress),
      verticalSpeedFpm: -650,
      onGround: false,
    };
  }
  const progress = (seconds - 84) / 6;
  return {
    altitudeM: 0,
    airspeedKt: interpolate(115, 0, progress),
    verticalSpeedFpm: 0,
    onGround: true,
  };
}

export function createDemoSession(startedAt = new Date()): FlightSession {
  return {
    schemaVersion: "1.0",
    sessionId: crypto.randomUUID(),
    source: "demo",
    state: "recording",
    startedAt: startedAt.toISOString(),
    completedAt: null,
    interruptedAt: null,
    sampleCount: 0,
    aircraft: "AeroTrace Synthetic Test Aircraft",
    error: null,
  };
}

export function createDemoSample(
  sessionId: string,
  elapsedSeconds: number,
  timestamp = new Date(),
): TelemetrySample {
  const elapsed = Math.max(
    0,
    Math.min(DEMO_FLIGHT_DURATION_SECONDS, elapsedSeconds),
  );
  const [latitudeDeg, longitudeDeg] = coordinatesAt(elapsed);
  const state = flightStateAt(elapsed);
  const previous = coordinatesAt(Math.max(0, elapsed - 1));
  const headingDeg =
    (Math.atan2(
      (longitudeDeg - previous[1]) *
        Math.cos(((latitudeDeg + previous[0]) / 2) * (Math.PI / 180)),
      latitudeDeg - previous[0],
    ) *
      (180 / Math.PI) +
      360) %
    360;
  const groundSpeedKt = Math.max(0, state.airspeedKt - 8);

  return {
    schemaVersion: "1.0",
    sampleId: crypto.randomUUID(),
    sessionId,
    timestamp: timestamp.toISOString(),
    source: "demo",
    latitudeDeg,
    longitudeDeg,
    altitudeM: state.altitudeM,
    headingDeg,
    airspeedMps: state.airspeedKt * METRES_PER_SECOND_PER_KNOT,
    groundSpeedMps: groundSpeedKt * METRES_PER_SECOND_PER_KNOT,
    verticalSpeedMps: state.verticalSpeedFpm * METRES_PER_SECOND_PER_FPM,
    onGround: state.onGround,
    quality: "calculated",
  };
}

function distanceMetres(a: TelemetrySample, b: TelemetrySample): number | null {
  if (
    a.latitudeDeg == null ||
    a.longitudeDeg == null ||
    b.latitudeDeg == null ||
    b.longitudeDeg == null
  )
    return null;
  const radians = Math.PI / 180;
  const dLat = (b.latitudeDeg - a.latitudeDeg) * radians;
  const dLon = (b.longitudeDeg - a.longitudeDeg) * radians;
  const haversine =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitudeDeg * radians) *
      Math.cos(b.latitudeDeg * radians) *
      Math.sin(dLon / 2) ** 2;
  return 6_371_008.8 * 2 * Math.asin(Math.sqrt(haversine));
}

function makePhases(samples: TelemetrySample[]): PhaseInterval[] {
  if (samples.length === 0) return [];
  const phases: PhaseInterval[] = [];
  let startIndex = 0;
  let currentPhase = phaseAt(0);

  for (let index = 1; index <= samples.length; index += 1) {
    const nextPhase = index < samples.length ? phaseAt(index) : null;
    if (nextPhase === currentPhase) continue;
    const first = samples[startIndex];
    const last = samples[index - 1];
    const startedAt = Date.parse(first.timestamp);
    const endedAt = Date.parse(last.timestamp);
    phases.push({
      phase: currentPhase,
      startedAt: first.timestamp,
      endedAt: last.timestamp,
      durationSeconds: Math.max(0, (endedAt - startedAt) / 1000),
      confidence: "high",
      uncertainty: null,
    });
    if (nextPhase) {
      currentPhase = nextPhase;
      startIndex = index;
    }
  }
  return phases;
}

function makeSummary(
  session: FlightSession,
  samples: TelemetrySample[],
  phases: PhaseInterval[],
) {
  const positions = samples.filter(
    (sample) => sample.latitudeDeg != null && sample.longitudeDeg != null,
  );
  let routeDistanceM = 0;
  let routeSegmentsCount = 0;
  for (let index = 1; index < positions.length; index += 1) {
    const previous = positions[index - 1];
    const current = positions[index];
    const seconds =
      (Date.parse(current.timestamp) - Date.parse(previous.timestamp)) / 1000;
    const distance =
      seconds > 0 && seconds <= 30 ? distanceMetres(previous, current) : null;
    if (distance != null) {
      routeDistanceM += distance;
      routeSegmentsCount += 1;
    }
  }
  const maximum = (
    pick: (sample: TelemetrySample) => number | null,
  ): number | null => {
    const values = samples.flatMap((sample) => {
      const value = pick(sample);
      return value == null ? [] : [value];
    });
    return values.length ? Math.max(...values) : null;
  };
  const average = (
    pick: (sample: TelemetrySample) => number | null,
  ): number | null => {
    const values = samples.flatMap((sample) => {
      const value = pick(sample);
      return value == null ? [] : [value];
    });
    return values.length
      ? values.reduce((total, value) => total + value, 0) / values.length
      : null;
  };
  const startedAt = session.startedAt ? Date.parse(session.startedAt) : NaN;
  const endedAt = session.completedAt
    ? Date.parse(session.completedAt)
    : samples.length
      ? Date.parse(samples[samples.length - 1].timestamp)
      : NaN;
  const recordingDurationSeconds =
    Number.isFinite(startedAt) && Number.isFinite(endedAt)
      ? Math.max(0, (endedAt - startedAt) / 1000)
      : null;
  const airborneDurationSeconds = samples
    .slice(1)
    .reduce((total, sample, index) => {
      const previous = samples[index];
      const delta =
        (Date.parse(sample.timestamp) - Date.parse(previous.timestamp)) / 1000;
      return previous.onGround === false && delta > 0 && delta <= 30
        ? total + delta
        : total;
    }, 0);
  const firstPosition = positions[0];
  const lastPosition = positions.at(-1);
  const phaseTimeSeconds = Object.fromEntries(
    phases.map((phase) => [phase.phase, phase.durationSeconds]),
  );
  const recordingStatus: FlightReport["recordingStatus"] =
    session.state === "completed"
      ? "complete"
      : session.state === "interrupted"
        ? "interrupted"
        : session.state === "error"
          ? "error"
          : "active";
  const summary = {
    calculationSource: "calculated_from_persisted_samples" as const,
    inputProvenance: samples.length
      ? ("calculated" as const)
      : ("unavailable" as const),
    recordingDurationSeconds,
    recordingDurationStatus:
      session.state === "completed"
        ? ("complete" as const)
        : recordingDurationSeconds == null
          ? ("unavailable" as const)
          : ("partial" as const),
    airborneDurationSeconds: samples.length ? airborneDurationSeconds : null,
    airborneDurationStatus: samples.length
      ? session.state === "completed"
        ? ("complete" as const)
        : ("partial" as const)
      : ("unavailable" as const),
    routeDistanceM,
    routeDistanceStatus: routeSegmentsCount
      ? ("observed_segments_only" as const)
      : ("no_valid_segments" as const),
    maximumAltitudeM: maximum((sample) => sample.altitudeM),
    maximumAirspeedMps: maximum((sample) => sample.airspeedMps),
    maximumGroundSpeedMps: maximum((sample) => sample.groundSpeedMps),
    averageGroundSpeedMps: average((sample) => sample.groundSpeedMps),
    maximumClimbRateMps: maximum((sample) =>
      sample.verticalSpeedMps == null
        ? null
        : Math.max(0, sample.verticalSpeedMps),
    ),
    maximumDescentRateMps: maximum((sample) =>
      sample.verticalSpeedMps == null
        ? null
        : Math.max(0, -sample.verticalSpeedMps),
    ),
    sampleCount: samples.length,
    uniqueSampleCount: new Set(samples.map((sample) => sample.sampleId)).size,
    validPositionSampleCount: positions.length,
    duplicateTimestampCount: 0,
    sampleCoveragePercent:
      recordingDurationSeconds == null
        ? null
        : Math.min(
            100,
            (samples.length / (Math.floor(recordingDurationSeconds) + 1)) * 100,
          ),
    positionCoveragePercent: samples.length
      ? (positions.length / samples.length) * 100
      : null,
    phaseTimeSeconds,
    firstPosition: firstPosition
      ? {
          timestamp: firstPosition.timestamp,
          latitudeDeg: firstPosition.latitudeDeg as number,
          longitudeDeg: firstPosition.longitudeDeg as number,
        }
      : null,
    lastPosition: lastPosition
      ? {
          timestamp: lastPosition.timestamp,
          latitudeDeg: lastPosition.latitudeDeg as number,
          longitudeDeg: lastPosition.longitudeDeg as number,
        }
      : null,
    takeoffEvents: samples
      .slice(1)
      .filter(
        (sample, index) =>
          samples[index].onGround === true && sample.onGround === false,
      ).length,
    landingEvents: samples
      .slice(1)
      .filter(
        (sample, index) =>
          samples[index].onGround === false && sample.onGround === true,
      ).length,
    routeGapCount: Math.max(0, positions.length - 1 - routeSegmentsCount),
  };
  return { summary, recordingStatus };
}

export function buildDemoReportBundle(
  session: FlightSession,
  telemetry: TelemetrySample[],
): FlightReportBundle {
  const samples = [...telemetry].sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
  const phases = makePhases(samples);
  const { summary, recordingStatus } = makeSummary(session, samples, phases);
  const events: FlightAnalysis["events"] = [];
  if (session.startedAt) {
    events.push({
      type: "recording_started",
      timestamp: session.startedAt,
      endTimestamp: null,
      confidence: "high",
      details: "Synthetic demo recording started.",
    });
  }
  for (const [sampleIndex, type, details] of DEMO_MILESTONES) {
    const sample = samples[sampleIndex];
    if (!sample) continue;
    events.push({
      type,
      timestamp: sample.timestamp,
      endTimestamp: null,
      confidence: "high",
      details,
    });
  }
  if (session.completedAt) {
    events.push({
      type: "recording_completed",
      timestamp: session.completedAt,
      endTimestamp: null,
      confidence: "high",
      details: "Synthetic demo recording was completed.",
    });
  }
  const positions = samples.filter(
    (sample) => sample.latitudeDeg != null && sample.longitudeDeg != null,
  );
  const routeSegments =
    positions.length > 1
      ? [
          {
            coordinates: positions.map(
              (sample) =>
                [
                  sample.longitudeDeg as number,
                  sample.latitudeDeg as number,
                ] as [number, number],
            ),
            startedAt: positions[0].timestamp,
            endedAt: positions.at(-1)!.timestamp,
          },
        ]
      : [];
  const report: FlightReport = {
    session,
    recordingStatus,
    summary,
  };
  const analysis: FlightAnalysis = {
    sessionId: session.sessionId,
    recordingStatus,
    summary,
    phases,
    events,
    routeSegments,
  };
  return { report, analysis, telemetry: samples };
}
