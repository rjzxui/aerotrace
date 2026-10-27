import assert from "node:assert/strict";
import test from "node:test";
import {
  claimFlightAction,
  fetchFlightAnalysis,
  fetchFlightList,
  fetchFlightReport,
  fetchFlightTelemetry,
  fetchFlightTelemetryWindow,
  finalizeFlight,
  IS_PUBLIC_DEMO_MODE,
  loadFlightReportBundle,
  parsePublicDemoMode,
  requestLocalConnector,
  resolveFlightApiConfiguration,
  resolveLocalApiUrl,
} from "./flight-api.ts";
import { DEMO_FLIGHT_SESSIONS, DEMO_PRIMARY_BUNDLE } from "./demo-data.ts";
import {
  FlightAnalysisSchema,
  FlightReportSchema,
  FlightSessionSchema,
  TelemetrySampleSchema,
} from "./contracts.ts";
import {
  buildFlightChartPoints,
  formatElapsedMinutes,
} from "./flight-report-model.ts";
import { mergeLiveSamples } from "./live-telemetry.ts";
import type {
  FlightAnalysis,
  FlightReport,
  FlightSession,
  TelemetrySample,
} from "./contracts.ts";

const sessionId = "99e57e44-14e7-4f7c-b246-7ce447d71a87";
const sampleId = "8acd161f-8e6d-43bb-a791-3c6f6ea94ddb";
const t0 = "2026-10-01T10:00:00Z";

function makeSession(
  source: "demo" | "simconnect" = "demo",
  state: FlightSession["state"] = "completed",
): FlightSession {
  return {
    schemaVersion: "1.0",
    sessionId,
    source,
    state,
    startedAt: t0,
    completedAt: state === "completed" ? "2026-10-01T10:00:03Z" : null,
    interruptedAt: state === "interrupted" ? "2026-10-01T10:00:04Z" : null,
    sampleCount: 1,
    aircraft:
      source === "simconnect"
        ? "Mock Aircraft"
        : "AeroTrace Synthetic Test Aircraft",
    error: null,
  };
}

function makeSample(overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    schemaVersion: "1.0",
    sampleId,
    sessionId,
    timestamp: t0,
    source: "demo",
    latitudeDeg: 37.6,
    longitudeDeg: -122.3,
    altitudeM: 1500,
    headingDeg: 90,
    airspeedMps: 70,
    groundSpeedMps: 72,
    verticalSpeedMps: 1,
    onGround: false,
    quality: "calculated",
    ...overrides,
  };
}

function makeSummary() {
  return {
    calculationSource: "calculated_from_persisted_samples" as const,
    inputProvenance: "calculated" as const,
    recordingDurationSeconds: 3,
    recordingDurationStatus: "complete" as const,
    airborneDurationSeconds: null,
    airborneDurationStatus: "unavailable" as const,
    routeDistanceM: 0,
    routeDistanceStatus: "no_valid_segments" as const,
    maximumAltitudeM: 1500,
    maximumAirspeedMps: 70,
    maximumGroundSpeedMps: 72,
    averageGroundSpeedMps: 72,
    maximumClimbRateMps: 1,
    maximumDescentRateMps: null,
    sampleCount: 1,
    uniqueSampleCount: 1,
    validPositionSampleCount: 1,
    duplicateTimestampCount: 0,
    sampleCoveragePercent: 25,
    positionCoveragePercent: 100,
    phaseTimeSeconds: {},
    firstPosition: { timestamp: t0, latitudeDeg: 37.6, longitudeDeg: -122.3 },
    lastPosition: { timestamp: t0, latitudeDeg: 37.6, longitudeDeg: -122.3 },
    takeoffEvents: 0,
    landingEvents: 0,
    routeGapCount: 0,
  };
}

function makeReport(state: FlightSession["state"] = "completed"): FlightReport {
  const recordingStatus =
    state === "completed"
      ? "complete"
      : state === "interrupted" || state === "error"
        ? state
        : "active";
  return {
    session: makeSession("demo", state),
    recordingStatus,
    summary: makeSummary(),
  };
}

function makeAnalysis(
  state: FlightAnalysis["recordingStatus"] = "complete",
): FlightAnalysis {
  return {
    sessionId,
    recordingStatus: state,
    summary: makeSummary(),
    phases: [],
    events: [],
    routeSegments: [],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchStub(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

function completedStatus() {
  return {
    state: "completed",
    source: "demo",
    selectedSource: "demo",
    simulator: { state: "not_detected", message: null, paused: false },
    session: makeSession(),
    message: null,
  };
}

test("claimFlightAction prevents duplicate completion submissions until released", () => {
  const lock = { current: false };
  assert.equal(claimFlightAction(lock), true);
  assert.equal(claimFlightAction(lock), false);
  lock.current = false;
  assert.equal(claimFlightAction(lock), true);
});

test("finalizeFlight requires persisted completed confirmation", async () => {
  const calls: string[] = [];
  const fetcher = fetchStub((url, init) => {
    calls.push(`${init?.method} ${url} ${init?.body ?? ""}`);
    return jsonResponse(completedStatus());
  });
  const status = await finalizeFlight(sessionId, fetcher);
  assert.equal(status.session?.sessionId, sessionId);
  assert.match(calls[0], /^POST /);
  assert.match(calls[0], new RegExp(`"sessionId":"${sessionId}"`));

  await assert.rejects(
    finalizeFlight(
      sessionId,
      fetchStub(() => jsonResponse({ detail: "connector unavailable" }, 503)),
    ),
    /connector unavailable/,
  );
  await assert.rejects(
    finalizeFlight(
      sessionId,
      fetchStub(() =>
        jsonResponse({
          ...completedStatus(),
          state: "recording",
          session: { ...makeSession(), state: "recording", completedAt: null },
        }),
      ),
    ),
    /did not confirm flight completion/,
  );
  await assert.rejects(
    finalizeFlight(
      "27b6b1b2-46e8-4c96-aa08-f2a85ad531b2",
      fetchStub(() => jsonResponse(completedStatus())),
    ),
    /did not confirm flight completion/,
  );
});

test("local API override accepts loopback only and rejects remote destinations", () => {
  assert.equal(resolveLocalApiUrl().baseUrl, "http://127.0.0.1:8765");
  assert.equal(
    resolveLocalApiUrl("http://localhost:9000/connector/").baseUrl,
    "http://localhost:9000/connector",
  );
  for (const value of [
    "https://localhost:8765",
    "http://192.168.1.4:8765",
    "http://example.com",
    "http://user:pass@localhost:8765",
    "http://localhost:8765?target=elsewhere",
  ]) {
    const result = resolveLocalApiUrl(value);
    assert.equal(result.baseUrl, "http://127.0.0.1:8765");
    assert.match(result.error ?? "", /local HTTP/);
  }
});

test("public demo flag is explicit and isolates the public build from loopback", async () => {
  assert.equal(parsePublicDemoMode("true"), true);
  assert.equal(parsePublicDemoMode(" TRUE "), true);
  assert.equal(parsePublicDemoMode("false"), false);
  assert.equal(parsePublicDemoMode("1"), false);
  assert.equal(parsePublicDemoMode(undefined), false);

  assert.deepEqual(
    resolveFlightApiConfiguration("http://127.0.0.1:8765", true),
    { baseUrl: "", error: null },
  );
  assert.equal(
    IS_PUBLIC_DEMO_MODE,
    parsePublicDemoMode(process.env.NEXT_PUBLIC_DEMO_MODE),
  );

  let requestCount = 0;
  const forbiddenFetch = fetchStub(() => {
    requestCount += 1;
    throw new Error("The local connector must not be contacted.");
  });
  await assert.rejects(
    requestLocalConnector("/api/status", undefined, forbiddenFetch, true),
    /disabled in public demo mode/,
  );
  assert.equal(requestCount, 0);
});

test("demo flight list, detail, telemetry and report use existing contracts without fetch", async () => {
  let requestCount = 0;
  const forbiddenFetch = fetchStub(() => {
    requestCount += 1;
    throw new Error("Demo mode must not fetch connector data.");
  });
  const sessions = await fetchFlightList(forbiddenFetch, true);
  assert.equal(sessions.length, 3);
  assert.deepEqual(
    FlightSessionSchema.array()
      .parse(sessions)
      .map((session) => session.source),
    ["demo", "demo", "demo"],
  );

  const session = sessions[0];
  const bundle = await loadFlightReportBundle(
    session.sessionId,
    forbiddenFetch,
    true,
  );
  assert.equal(bundle.report.recordingStatus, "complete");
  assert.equal(bundle.report.session.state, "completed");
  assert.equal(bundle.report.summary.inputProvenance, "calculated");
  assert.equal(bundle.telemetry.length, session.sampleCount);
  assert.equal(bundle.telemetry[0].source, "demo");
  assert.equal(bundle.telemetry[0].quality, "calculated");
  assert.ok(bundle.telemetry.some((sample) => sample.altitudeM != null));
  assert.ok(bundle.telemetry.some((sample) => sample.airspeedMps != null));

  FlightReportSchema.parse(bundle.report);
  FlightAnalysisSchema.parse(bundle.analysis);
  TelemetrySampleSchema.array().parse(bundle.telemetry);
  assert.deepEqual(
    await fetchFlightReport(session.sessionId, forbiddenFetch, true),
    bundle.report,
  );
  assert.deepEqual(
    await fetchFlightAnalysis(session.sessionId, forbiddenFetch, true),
    bundle.analysis,
  );
  assert.deepEqual(
    await fetchFlightTelemetryWindow(
      session.sessionId,
      "demo",
      session.sampleCount,
      forbiddenFetch,
      undefined,
      true,
    ),
    bundle.telemetry,
  );
  assert.deepEqual(
    await fetchFlightTelemetry(
      session.sessionId,
      "demo",
      forbiddenFetch,
      undefined,
      true,
    ),
    bundle.telemetry,
  );
  await assert.rejects(
    fetchFlightTelemetry(
      session.sessionId,
      "simconnect",
      forbiddenFetch,
      undefined,
      true,
    ),
    /did not match the selected flight session/,
  );
  assert.deepEqual(DEMO_FLIGHT_SESSIONS, sessions);
  assert.equal(DEMO_PRIMARY_BUNDLE.report.session.sessionId, session.sessionId);
  await assert.rejects(
    finalizeFlight(session.sessionId, forbiddenFetch, true),
    /disabled in public demo mode/,
  );
  await assert.rejects(
    loadFlightReportBundle(
      "00000000-0000-4000-8000-000000000000",
      forbiddenFetch,
      true,
    ),
    /Sample flight not found/,
  );
  assert.equal(requestCount, 0);
});

test("elapsed chart labels retain seconds for sub-minute flights", () => {
  assert.equal(formatElapsedMinutes(0), "0s");
  assert.equal(formatElapsedMinutes(0.5), "30s");
  assert.equal(formatElapsedMinutes(1), "1m");
  assert.equal(formatElapsedMinutes(61), "1h01");
});

test("live telemetry merge orders, deduplicates and bounds reconnect data", () => {
  const first = makeSample({ sampleId: "sample-a", timestamp: t0 });
  const second = makeSample({
    sampleId: "sample-b",
    timestamp: "2026-10-01T10:00:01Z",
  });
  const third = makeSample({
    sampleId: "sample-c",
    timestamp: "2026-10-01T10:00:02Z",
  });
  assert.deepEqual(
    mergeLiveSamples([second], [third, first, second], 2).map(
      (sample) => sample.sampleId,
    ),
    ["sample-b", "sample-c"],
  );
  assert.deepEqual(mergeLiveSamples([first, second], [first]), [first, second]);
});

test("recording sync loads only the bounded tail and validates source and session", async () => {
  const sample = makeSample();
  let requestUrl = "";
  const history = await fetchFlightTelemetryWindow(
    sessionId,
    "demo",
    7_500,
    fetchStub((url) => {
      requestUrl = url;
      return jsonResponse([sample]);
    }),
  );
  assert.equal(history.length, 1);
  assert.match(requestUrl, /offset=2500&limit=5000$/);
  await assert.rejects(
    fetchFlightTelemetryWindow(
      sessionId,
      "simconnect",
      1,
      fetchStub(() => jsonResponse([sample])),
    ),
    /did not match/,
  );
});

test("full report telemetry is paged beyond the connector's 10,000-sample limit", async () => {
  const offsets: number[] = [];
  const samples = await fetchFlightTelemetry(
    sessionId,
    "demo",
    fetchStub((url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      offsets.push(offset);
      return jsonResponse(
        offset === 0
          ? Array.from({ length: 10_000 }, () => makeSample())
          : [makeSample({ sampleId: "0c7a1d9c-fbef-4332-8cd5-5673dcbdc20c" })],
      );
    }),
  );
  assert.deepEqual(offsets, [0, 10_000]);
  assert.equal(samples.length, 10_001);
});

test("report bundle retrieves the exact persisted flight and source-specific samples", async () => {
  const seen: string[] = [];
  const fetcher = fetchStub((url) => {
    seen.push(url);
    if (url.endsWith(`/api/flights/${sessionId}`))
      return jsonResponse(makeReport());
    if (url.endsWith(`/api/flights/${sessionId}/analysis`))
      return jsonResponse(makeAnalysis());
    if (url.includes(`/api/flights/${sessionId}/telemetry?`))
      return jsonResponse([makeSample()]);
    return jsonResponse({ detail: "not found" }, 404);
  });
  const bundle = await loadFlightReportBundle(sessionId, fetcher);
  assert.equal(bundle.report.session.sessionId, sessionId);
  assert.equal(bundle.analysis.sessionId, sessionId);
  assert.equal(bundle.telemetry[0].source, "demo");
  assert.equal(bundle.telemetry[0].quality, "calculated");
  assert.equal(seen.length, 3);
});

test("report reopening supports an interrupted session after connector restart", async () => {
  const fetcher = fetchStub((url) => {
    if (url.endsWith(`/api/flights/${sessionId}`))
      return jsonResponse(makeReport("interrupted"));
    if (url.endsWith(`/api/flights/${sessionId}/analysis`))
      return jsonResponse(makeAnalysis("interrupted"));
    if (url.includes(`/api/flights/${sessionId}/telemetry?`))
      return jsonResponse([makeSample()]);
    return jsonResponse({ detail: "not found" }, 404);
  });
  const bundle = await loadFlightReportBundle(sessionId, fetcher);
  assert.equal(bundle.report.recordingStatus, "interrupted");
  assert.equal(bundle.report.session.completedAt, null);
});

test("history returns an explicit empty collection for a new local archive", async () => {
  const sessions = await fetchFlightList(fetchStub(() => jsonResponse([])));
  assert.deepEqual(sessions, []);
});

test("MSFS report samples retain observed provenance", async () => {
  const realSession = makeSession("simconnect");
  const observed = makeSample({ source: "simconnect", quality: "observed" });
  const observedSummary = {
    ...makeSummary(),
    inputProvenance: "observed" as const,
  };
  const realReport: FlightReport = {
    ...makeReport(),
    session: realSession,
    summary: observedSummary,
  };
  const fetcher = fetchStub((url) => {
    if (url.endsWith(`/api/flights/${sessionId}`))
      return jsonResponse(realReport);
    if (url.endsWith(`/api/flights/${sessionId}/analysis`))
      return jsonResponse({ ...makeAnalysis(), summary: observedSummary });
    if (url.includes(`/api/flights/${sessionId}/telemetry?`))
      return jsonResponse([observed]);
    return jsonResponse({ detail: "not found" }, 404);
  });
  const bundle = await loadFlightReportBundle(sessionId, fetcher);
  assert.equal(bundle.report.session.source, "simconnect");
  assert.equal(bundle.telemetry[0].quality, "observed");
});

test("report retrieval errors can be retried without resubmitting finalization", async () => {
  let attempts = 0;
  const fetcher = fetchStub((url) => {
    if (url.endsWith(`/api/flights/${sessionId}`)) {
      attempts += 1;
      return attempts === 1
        ? jsonResponse({ detail: "report temporarily unavailable" }, 503)
        : jsonResponse(makeReport());
    }
    if (url.endsWith(`/api/flights/${sessionId}/analysis`))
      return jsonResponse(makeAnalysis());
    if (url.includes(`/api/flights/${sessionId}/telemetry?`))
      return jsonResponse([makeSample()]);
    return jsonResponse({ detail: "not found" }, 404);
  });
  await assert.rejects(
    loadFlightReportBundle(sessionId, fetcher),
    /report temporarily unavailable/,
  );
  const retry = await loadFlightReportBundle(sessionId, fetcher);
  assert.equal(retry.report.recordingStatus, "complete");
  assert.equal(attempts, 2);
});

test("missing telemetry values remain null and are never replaced with zero", async () => {
  const missing = makeSample({
    latitudeDeg: null,
    longitudeDeg: null,
    altitudeM: null,
    airspeedMps: null,
    groundSpeedMps: null,
    verticalSpeedMps: null,
    onGround: null,
  });
  const fetcher = fetchStub((url) => {
    if (url.includes(`/api/flights/${sessionId}/telemetry?`))
      return jsonResponse([missing]);
    return jsonResponse({ detail: "unused" }, 404);
  });
  const samples = await fetchFlightTelemetry(sessionId, "demo", fetcher);
  assert.equal(samples[0].altitudeM, null);
  assert.equal(samples[0].latitudeDeg, null);
  assert.equal(samples[0].groundSpeedMps, null);
});

test("telemetry from another session or provider is rejected", async () => {
  const fetcher = fetchStub(() =>
    jsonResponse([makeSample({ source: "simconnect", quality: "observed" })]),
  );
  await assert.rejects(
    fetchFlightTelemetry(sessionId, "demo", fetcher),
    /did not match/,
  );
});

test("report identity mismatches are rejected", async () => {
  await assert.rejects(
    fetchFlightReport(
      sessionId,
      fetchStub(() =>
        jsonResponse({
          ...makeReport(),
          session: {
            ...makeSession(),
            sessionId: "27b6b1b2-46e8-4c96-aa08-f2a85ad531b2",
          },
        }),
      ),
    ),
    /different flight/,
  );
});

test("chart model preserves unavailable metrics and timestamps across route gaps", () => {
  const samples = [
    makeSample(),
    makeSample({
      sampleId: "0c7a1d9c-fbef-4332-8cd5-5673dcbdc20c",
      timestamp: "2026-10-01T10:00:40Z",
      latitudeDeg: null,
      longitudeDeg: null,
      altitudeM: null,
    }),
    makeSample({
      sampleId: "f51f5dbd-4404-48e1-a82e-c498c9f20c14",
      timestamp: "2026-10-01T10:01:00Z",
      latitudeDeg: 37.7,
      longitudeDeg: -122.2,
    }),
  ];
  const points = buildFlightChartPoints(samples, 2);
  assert.equal(points.length, 2);
  assert.equal(points.at(-1)?.timeMs, Date.parse(samples.at(-1)!.timestamp));
  assert.equal(buildFlightChartPoints(samples)[1].altitudeFt, null);
  assert.equal(
    buildFlightChartPoints(samples)[1].timeMs,
    Date.parse(samples[1].timestamp),
  );
});
