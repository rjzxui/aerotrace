import { z } from "zod";

/** Shared wire-level units are explicit; null means a measurement was unavailable. */
export const TelemetrySampleSchema = z.object({
  schemaVersion: z.literal("1.0"),
  sampleId: z.string().uuid(),
  sessionId: z.string().uuid(),
  timestamp: z.string().datetime({ offset: true }),
  source: z.enum(["simconnect", "demo"]),
  latitudeDeg: z.number().min(-90).max(90).nullable(),
  longitudeDeg: z.number().min(-180).max(180).nullable(),
  altitudeM: z.number().nullable(),
  headingDeg: z.number().min(0).lt(360).nullable(),
  airspeedMps: z.number().nonnegative().nullable(),
  groundSpeedMps: z.number().nonnegative().nullable(),
  verticalSpeedMps: z.number().nullable(),
  onGround: z.boolean().nullable(),
  quality: z.enum(["observed", "calculated"]),
});
export type TelemetrySample = z.infer<typeof TelemetrySampleSchema>;

export const FlightLifecycle = [
  "disconnected",
  "connected",
  "recording",
  "finalizing",
  "completed",
  "interrupted",
  "error",
] as const;
export type FlightLifecycleState = (typeof FlightLifecycle)[number];
export const FlightSessionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  sessionId: z.string().uuid(),
  source: z.enum(["simconnect", "demo"]),
  state: z.enum(FlightLifecycle),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  interruptedAt: z.string().datetime({ offset: true }).nullable().optional(),
  sampleCount: z.number().int().nonnegative(),
  aircraft: z.string().nullable(),
  error: z.string().nullable(),
});
export type FlightSession = z.infer<typeof FlightSessionSchema>;

export const ConnectorStatusSchema = z.object({
  state: z.enum(FlightLifecycle),
  source: z.enum(["simconnect", "demo"]).nullable(),
  selectedSource: z.enum(["simconnect", "demo"]),
  simulator: z.object({
    state: z.enum([
      "not_detected",
      "connecting",
      "connected",
      "waiting_for_flight",
      "recording",
      "connection_lost",
      "reconnecting",
      "error",
    ]),
    message: z.string().nullable(),
    paused: z.boolean(),
  }),
  session: FlightSessionSchema.nullable(),
  message: z.string().nullable().optional(),
});
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;

export const FlightSummarySchema = z.object({
  calculationSource: z.literal("calculated_from_persisted_samples"),
  inputProvenance: z.enum(["observed", "calculated", "mixed", "unavailable"]),
  recordingDurationSeconds: z.number().nullable(),
  recordingDurationStatus: z.enum([
    "complete",
    "interrupted",
    "partial",
    "active",
    "unavailable",
  ]),
  airborneDurationSeconds: z.number().nullable(),
  airborneDurationStatus: z.enum(["complete", "partial", "unavailable"]),
  routeDistanceM: z.number(),
  routeDistanceStatus: z.enum(["observed_segments_only", "no_valid_segments"]),
  maximumAltitudeM: z.number().nullable(),
  maximumAirspeedMps: z.number().nullable(),
  maximumGroundSpeedMps: z.number().nullable(),
  averageGroundSpeedMps: z.number().nullable(),
  maximumClimbRateMps: z.number().nullable(),
  maximumDescentRateMps: z.number().nullable(),
  sampleCount: z.number().int().nonnegative(),
  uniqueSampleCount: z.number().int().nonnegative(),
  validPositionSampleCount: z.number().int().nonnegative(),
  duplicateTimestampCount: z.number().int().nonnegative(),
  sampleCoveragePercent: z.number().nullable(),
  positionCoveragePercent: z.number().nullable(),
  phaseTimeSeconds: z.record(z.string(), z.number()),
  firstPosition: z
    .object({
      timestamp: z.string().datetime({ offset: true }),
      latitudeDeg: z.number(),
      longitudeDeg: z.number(),
    })
    .nullable(),
  lastPosition: z
    .object({
      timestamp: z.string().datetime({ offset: true }),
      latitudeDeg: z.number(),
      longitudeDeg: z.number(),
    })
    .nullable(),
  takeoffEvents: z.number().int().nonnegative(),
  landingEvents: z.number().int().nonnegative(),
  routeGapCount: z.number().int().nonnegative(),
});
export type FlightSummary = z.infer<typeof FlightSummarySchema>;

export const FlightReportSchema = z.object({
  session: FlightSessionSchema,
  recordingStatus: z.enum(["complete", "interrupted", "active", "error"]),
  summary: FlightSummarySchema,
});
export type FlightReport = z.infer<typeof FlightReportSchema>;

export const FlightEventSchema = z.object({
  type: z.string(),
  timestamp: z.string().datetime({ offset: true }),
  endTimestamp: z.string().datetime({ offset: true }).nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  details: z.string(),
});
export type FlightEvent = z.infer<typeof FlightEventSchema>;

export const PhaseIntervalSchema = z.object({
  phase: z.enum([
    "on_ground",
    "takeoff_initial_climb",
    "climb",
    "cruise",
    "descent",
    "approach",
    "landing_rollout",
    "uncertain",
  ]),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  durationSeconds: z.number().nonnegative(),
  confidence: z.enum(["high", "medium", "low"]),
  uncertainty: z.string().nullable(),
});
export type PhaseInterval = z.infer<typeof PhaseIntervalSchema>;

export const FlightAnalysisSchema = z.object({
  sessionId: z.string().uuid(),
  recordingStatus: z.enum(["complete", "interrupted", "active", "error"]),
  summary: FlightSummarySchema,
  phases: z.array(PhaseIntervalSchema),
  events: z.array(FlightEventSchema),
  routeSegments: z.array(
    z.object({
      coordinates: z.array(z.tuple([z.number(), z.number()])),
      startedAt: z.string().datetime({ offset: true }),
      endedAt: z.string().datetime({ offset: true }),
    }),
  ),
});
export type FlightAnalysis = z.infer<typeof FlightAnalysisSchema>;
