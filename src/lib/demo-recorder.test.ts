import assert from "node:assert/strict";
import test from "node:test";
import {
  FlightAnalysisSchema,
  FlightReportSchema,
  FlightSessionSchema,
  TelemetrySampleSchema,
} from "./contracts.ts";
import {
  buildDemoReportBundle,
  createDemoSample,
  createDemoSession,
  DEMO_FLIGHT_DURATION_SECONDS,
} from "./demo-recorder.ts";

test("synthetic telemetry follows a bounded ground-to-ground flight profile", () => {
  const startedAt = new Date("2026-10-28T12:00:00.000Z");
  const session = createDemoSession(startedAt);
  const samples = Array.from(
    { length: DEMO_FLIGHT_DURATION_SECONDS + 1 },
    (_, elapsed) =>
      TelemetrySampleSchema.parse(
        createDemoSample(
          session.sessionId,
          elapsed,
          new Date(startedAt.getTime() + elapsed * 1000),
        ),
      ),
  );
  const speedKt = (index: number) =>
    (samples[index].groundSpeedMps ?? 0) * 1.94384;

  assert.equal(samples[0].onGround, true);
  assert.equal(samples[0].altitudeM, 0);
  assert.equal(samples[10].onGround, false);
  assert.ok(samples[33].altitudeM! > 5_000);
  assert.ok(Math.abs(samples[45].verticalSpeedMps!) < 1);
  assert.ok(samples[62].verticalSpeedMps! < 0);
  assert.equal(samples.at(-1)?.onGround, true);
  assert.ok(speedKt(7) > speedKt(1));
  assert.ok(speedKt(90) < speedKt(84));
  assert.ok(samples[0].latitudeDeg !== samples.at(-1)?.latitudeDeg);
  assert.equal(
    new Set(samples.map((sample) => sample.sampleId)).size,
    samples.length,
  );
  assert.ok(
    samples.every(
      (sample) =>
        sample.sessionId === session.sessionId &&
        sample.source === "demo" &&
        sample.quality === "calculated",
    ),
  );
});

test("completed demo bundles include a validated report, route and phase timeline", () => {
  const startedAt = new Date("2026-10-28T12:00:00.000Z");
  const session = createDemoSession(startedAt);
  const telemetry = Array.from(
    { length: DEMO_FLIGHT_DURATION_SECONDS + 1 },
    (_, elapsed) =>
      createDemoSample(
        session.sessionId,
        elapsed,
        new Date(startedAt.getTime() + elapsed * 1000),
      ),
  );
  const completedSession = {
    ...session,
    state: "completed" as const,
    completedAt: new Date(
      startedAt.getTime() + DEMO_FLIGHT_DURATION_SECONDS * 1000,
    ).toISOString(),
    sampleCount: telemetry.length,
  };
  const bundle = buildDemoReportBundle(completedSession, telemetry);

  assert.equal(FlightSessionSchema.parse(bundle.report.session).source, "demo");
  assert.equal(
    FlightReportSchema.parse(bundle.report).recordingStatus,
    "complete",
  );
  assert.equal(
    FlightAnalysisSchema.parse(bundle.analysis).sessionId,
    session.sessionId,
  );
  assert.equal(bundle.report.summary.sampleCount, telemetry.length);
  assert.equal(bundle.report.summary.takeoffEvents, 1);
  assert.equal(bundle.report.summary.landingEvents, 1);
  assert.equal(bundle.analysis.routeSegments.length, 1);
  assert.deepEqual(
    bundle.analysis.phases.map((phase) => phase.phase),
    [
      "on_ground",
      "takeoff_initial_climb",
      "climb",
      "cruise",
      "descent",
      "approach",
      "landing_rollout",
    ],
  );

  assert.notEqual(createDemoSession(startedAt).sessionId, session.sessionId);
});
