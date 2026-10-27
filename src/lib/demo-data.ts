import type {
  ConnectorStatus,
  FlightAnalysis,
  FlightReport,
  FlightSession,
  PhaseInterval,
  TelemetrySample,
} from "./contracts.ts";
import type { FlightReportBundle } from "./flight-api.ts";

const FEET_TO_METRES = 0.3048;
const KNOTS_TO_METRES_PER_SECOND = 1 / 1.94384;
const FPM_TO_METRES_PER_SECOND = 1 / 196.8504;

type DemoFlight = {
  sessionId: string;
  samplePrefix: string;
  aircraft: string;
  startedAt: string;
  durationSeconds: number;
  start: [latitude: number, longitude: number];
  end: [latitude: number, longitude: number];
  maximumAltitudeFt: number;
  cruiseSpeedKt: number;
  windOffsetKt: number;
  curveDegrees: number;
};

const FLIGHTS: DemoFlight[] = [
  {
    sessionId: "a0000000-0000-4000-8000-000000000001",
    samplePrefix: "b1000000",
    aircraft: "Citation Latitude · SAMPLE",
    startedAt: "2026-10-24T16:00:00.000Z",
    durationSeconds: 1800,
    start: [37.6213, -122.379],
    end: [39.4999, -119.7681],
    maximumAltitudeFt: 20000,
    cruiseSpeedKt: 360,
    windOffsetKt: 12,
    curveDegrees: 0.055,
  },
  {
    sessionId: "a0000000-0000-4000-8000-000000000002",
    samplePrefix: "b2000000",
    aircraft: "Citation Latitude · SAMPLE",
    startedAt: "2026-10-22T18:30:00.000Z",
    durationSeconds: 2400,
    start: [33.4343, -112.0116],
    end: [36.084, -115.1537],
    maximumAltitudeFt: 26000,
    cruiseSpeedKt: 380,
    windOffsetKt: 18,
    curveDegrees: -0.06,
  },
  {
    sessionId: "a0000000-0000-4000-8000-000000000003",
    samplePrefix: "b3000000",
    aircraft: "Citation Latitude · SAMPLE",
    startedAt: "2026-10-20T14:15:00.000Z",
    durationSeconds: 1560,
    start: [47.4502, -122.3088],
    end: [45.5898, -122.5951],
    maximumAltitudeFt: 14000,
    cruiseSpeedKt: 300,
    windOffsetKt: 9,
    curveDegrees: 0.045,
  },
];

function timestampAt(flight: DemoFlight, seconds: number) {
  return new Date(Date.parse(flight.startedAt) + seconds * 1000).toISOString();
}

function interpolate(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
}

function bearingDegrees(start: DemoFlight["start"], end: DemoFlight["end"]) {
  const radians = Math.PI / 180;
  const lat1 = start[0] * radians;
  const lat2 = end[0] * radians;
  const longitudeDelta = (end[1] - start[1]) * radians;
  const y = Math.sin(longitudeDelta) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(longitudeDelta);
  return (Math.atan2(y, x) / radians + 360) % 360;
}

function greatCircleDistanceM(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
) {
  const radians = Math.PI / 180;
  const latitudeDelta = (latitudeB - latitudeA) * radians;
  const longitudeDelta = (longitudeB - longitudeA) * radians;
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA * radians) *
      Math.cos(latitudeB * radians) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function flightProfile(flight: DemoFlight, seconds: number) {
  const climbEnd = Math.floor(flight.durationSeconds * 0.28);
  const cruiseEnd = Math.floor(flight.durationSeconds * 0.7);
  const descentEnd = flight.durationSeconds - 60;
  const onGround = seconds < 60 || seconds >= descentEnd;
  let altitudeFt = 0;
  let verticalSpeedFpm = 0;
  let speedKt = 0;

  if (!onGround && seconds < climbEnd) {
    const climbProgress = (seconds - 60) / (climbEnd - 60);
    altitudeFt = flight.maximumAltitudeFt * climbProgress;
    verticalSpeedFpm = (flight.maximumAltitudeFt * 60) / (climbEnd - 60);
    speedKt = interpolate(120, flight.cruiseSpeedKt * 0.92, climbProgress);
  } else if (!onGround && seconds < cruiseEnd) {
    altitudeFt = flight.maximumAltitudeFt;
    verticalSpeedFpm = Math.sin(seconds / 85) * 55;
    speedKt = flight.cruiseSpeedKt + Math.sin(seconds / 120) * 7;
  } else if (!onGround) {
    const descentProgress = (seconds - cruiseEnd) / (descentEnd - cruiseEnd);
    altitudeFt = flight.maximumAltitudeFt * (1 - descentProgress);
    verticalSpeedFpm =
      -(flight.maximumAltitudeFt * 60) / (descentEnd - cruiseEnd);
    speedKt = interpolate(flight.cruiseSpeedKt, 145, descentProgress);
  } else if (seconds < 60) {
    speedKt = interpolate(0, 95, seconds / 60);
  } else {
    speedKt = interpolate(
      95,
      0,
      (seconds - descentEnd) / (flight.durationSeconds - descentEnd),
    );
  }

  const progress = seconds / flight.durationSeconds;
  const curve = Math.sin(Math.PI * progress) * flight.curveDegrees;
  const latitudeDeg =
    interpolate(flight.start[0], flight.end[0], progress) + curve;
  const longitudeDeg =
    interpolate(flight.start[1], flight.end[1], progress) - curve * 0.55;
  const groundSpeedKt = Math.max(0, speedKt - flight.windOffsetKt);

  return {
    latitudeDeg,
    longitudeDeg,
    altitudeM: altitudeFt * FEET_TO_METRES,
    headingDeg: bearingDegrees(flight.start, flight.end),
    airspeedMps: speedKt * KNOTS_TO_METRES_PER_SECOND,
    groundSpeedMps: groundSpeedKt * KNOTS_TO_METRES_PER_SECOND,
    verticalSpeedMps: verticalSpeedFpm * FPM_TO_METRES_PER_SECOND,
    onGround,
  };
}

function makeSamples(flight: DemoFlight): TelemetrySample[] {
  return Array.from({ length: flight.durationSeconds + 1 }, (_, seconds) => ({
    schemaVersion: "1.0" as const,
    sampleId: `${flight.samplePrefix}-0000-4000-8000-${seconds.toString(16).padStart(12, "0")}`,
    sessionId: flight.sessionId,
    timestamp: timestampAt(flight, seconds),
    source: "demo" as const,
    ...flightProfile(flight, seconds),
    quality: "calculated" as const,
  }));
}

function makeSession(flight: DemoFlight, sampleCount: number): FlightSession {
  return {
    schemaVersion: "1.0",
    sessionId: flight.sessionId,
    source: "demo",
    state: "completed",
    startedAt: flight.startedAt,
    completedAt: timestampAt(flight, flight.durationSeconds),
    interruptedAt: null,
    sampleCount,
    aircraft: flight.aircraft,
    error: null,
  };
}

function makePhases(flight: DemoFlight): PhaseInterval[] {
  const climbEnd = Math.floor(flight.durationSeconds * 0.28);
  const cruiseEnd = Math.floor(flight.durationSeconds * 0.7);
  const descentEnd = flight.durationSeconds - 60;
  const ranges: Array<[PhaseInterval["phase"], number, number]> = [
    ["on_ground", 0, 60],
    ["takeoff_initial_climb", 60, 120],
    ["climb", 120, climbEnd],
    ["cruise", climbEnd, cruiseEnd],
    ["descent", cruiseEnd, descentEnd],
    ["landing_rollout", descentEnd, flight.durationSeconds],
  ];
  return ranges.map(([phase, start, end]) => ({
    phase,
    startedAt: timestampAt(flight, start),
    endedAt: timestampAt(flight, end),
    durationSeconds: end - start,
    confidence: "high",
    uncertainty: null,
  }));
}

function makeSummary(
  flight: DemoFlight,
  samples: TelemetrySample[],
  phases: PhaseInterval[],
) {
  let routeDistanceM = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    routeDistanceM += greatCircleDistanceM(
      previous.latitudeDeg ?? 0,
      previous.longitudeDeg ?? 0,
      current.latitudeDeg ?? 0,
      current.longitudeDeg ?? 0,
    );
  }
  const maximum = (select: (sample: TelemetrySample) => number | null) =>
    Math.max(...samples.map((sample) => select(sample) ?? -Infinity));
  const verticalRates = samples.map((sample) => sample.verticalSpeedMps ?? 0);
  const first = samples[0];
  const last = samples[samples.length - 1];

  return {
    calculationSource: "calculated_from_persisted_samples" as const,
    inputProvenance: "calculated" as const,
    recordingDurationSeconds: flight.durationSeconds,
    recordingDurationStatus: "complete" as const,
    airborneDurationSeconds: flight.durationSeconds - 120,
    airborneDurationStatus: "complete" as const,
    routeDistanceM,
    routeDistanceStatus: "observed_segments_only" as const,
    maximumAltitudeM: maximum((sample) => sample.altitudeM),
    maximumAirspeedMps: maximum((sample) => sample.airspeedMps),
    maximumGroundSpeedMps: maximum((sample) => sample.groundSpeedMps),
    averageGroundSpeedMps:
      samples.reduce(
        (total, sample) => total + (sample.groundSpeedMps ?? 0),
        0,
      ) / samples.length,
    maximumClimbRateMps: Math.max(...verticalRates, 0),
    maximumDescentRateMps: Math.max(...verticalRates.map((rate) => -rate), 0),
    sampleCount: samples.length,
    uniqueSampleCount: samples.length,
    validPositionSampleCount: samples.length,
    duplicateTimestampCount: 0,
    sampleCoveragePercent: 100,
    positionCoveragePercent: 100,
    phaseTimeSeconds: Object.fromEntries(
      phases.map((phase) => [phase.phase, phase.durationSeconds]),
    ),
    firstPosition: {
      timestamp: first.timestamp,
      latitudeDeg: first.latitudeDeg ?? 0,
      longitudeDeg: first.longitudeDeg ?? 0,
    },
    lastPosition: {
      timestamp: last.timestamp,
      latitudeDeg: last.latitudeDeg ?? 0,
      longitudeDeg: last.longitudeDeg ?? 0,
    },
    takeoffEvents: 1,
    landingEvents: 1,
    routeGapCount: 0,
  };
}

function makeBundle(flight: DemoFlight): FlightReportBundle {
  const telemetry = makeSamples(flight);
  const session = makeSession(flight, telemetry.length);
  const phases = makePhases(flight);
  const summary = makeSummary(flight, telemetry, phases);
  const report: FlightReport = {
    session,
    recordingStatus: "complete",
    summary,
  };
  const analysis: FlightAnalysis = {
    sessionId: flight.sessionId,
    recordingStatus: "complete",
    summary,
    phases,
    events: [
      {
        type: "flight_started",
        timestamp: timestampAt(flight, 0),
        endTimestamp: null,
        confidence: "high",
        details: "Sample flight recording started.",
      },
      {
        type: "takeoff",
        timestamp: timestampAt(flight, 60),
        endTimestamp: null,
        confidence: "high",
        details: "Sample on-ground status changed to airborne.",
      },
      {
        type: "landing",
        timestamp: timestampAt(flight, flight.durationSeconds - 60),
        endTimestamp: null,
        confidence: "high",
        details: "Sample on-ground status changed to landed.",
      },
      {
        type: "flight_completed",
        timestamp: timestampAt(flight, flight.durationSeconds),
        endTimestamp: null,
        confidence: "high",
        details: "Sample flight record was completed.",
      },
    ],
    routeSegments: [
      {
        coordinates: telemetry.map(
          (sample) =>
            [sample.longitudeDeg ?? 0, sample.latitudeDeg ?? 0] as [
              number,
              number,
            ],
        ),
        startedAt: telemetry[0].timestamp,
        endedAt: telemetry[telemetry.length - 1].timestamp,
      },
    ],
  };
  return { report, analysis, telemetry };
}

const DEMO_BUNDLES = FLIGHTS.map(makeBundle);

export const DEMO_FLIGHT_SESSIONS = DEMO_BUNDLES.map(
  ({ report }) => report.session,
);
export const DEMO_PRIMARY_BUNDLE = DEMO_BUNDLES[0];
export const DEMO_PRIMARY_STATUS: ConnectorStatus = {
  state: "completed",
  source: "demo",
  selectedSource: "demo",
  simulator: { state: "not_detected", message: null, paused: false },
  session: DEMO_PRIMARY_BUNDLE.report.session,
  message: null,
};

export function getDemoFlightBundle(sessionId: string): FlightReportBundle {
  const bundle = DEMO_BUNDLES.find(
    (candidate) => candidate.report.session.sessionId === sessionId,
  );
  if (!bundle) throw new Error("Sample flight not found.");
  return bundle;
}
