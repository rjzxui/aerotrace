"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";
import AeroTraceHeader from "@/components/aerotrace-header";
import FlightReplayMap from "@/components/flight-replay-map";
import FlightReportCharts from "@/components/flight-report-charts";
import FlightReportTimeline from "@/components/flight-report-timeline";
import {
  IS_PUBLIC_DEMO_MODE,
  loadFlightReportBundle,
  retryDemoFlightSqliteArchive,
} from "@/lib/flight-api";
import type { FlightReportBundle } from "@/lib/flight-api";
import type { TelemetrySample } from "@/lib/contracts";

const PHASE_ORDER = [
  "on_ground",
  "takeoff_initial_climb",
  "climb",
  "cruise",
  "descent",
  "approach",
  "landing_rollout",
  "uncertain",
];

type ReportLoadState =
  | { sessionId: string; state: "loading" }
  | { sessionId: string; state: "ready"; bundle: FlightReportBundle }
  | { sessionId: string; state: "error"; error: string };

function formatUtc(value: string | null | undefined) {
  if (!value) return "Unavailable";
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

function formatDuration(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return "Unavailable";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, "0")}m ${String(remaining).padStart(2, "0")}s`
    : `${minutes}m ${String(remaining).padStart(2, "0")}s`;
}

function metric(
  value: number | null,
  unit: string,
  multiplier = 1,
  decimals = 0,
) {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  return `${(value * multiplier).toLocaleString("en-US", { maximumFractionDigits: decimals })} ${unit}`;
}

function coordinate(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
) {
  if (latitude == null || longitude == null) return "Unavailable";
  return `${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°`;
}

function sourceLabel(source: "demo" | "simconnect") {
  return source === "demo" ? "DEMO · SYNTHETIC TELEMETRY" : "MSFS · SIMCONNECT";
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ").toUpperCase();
}

function SummaryMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <article className="summary-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </article>
  );
}

function emptyCounts(samples: TelemetrySample[]) {
  const countNull = (select: (sample: TelemetrySample) => unknown) =>
    samples.reduce((sum, sample) => sum + (select(sample) == null ? 1 : 0), 0);
  return [
    [
      "Position",
      samples.reduce(
        (sum, sample) =>
          sum +
          (sample.latitudeDeg == null || sample.longitudeDeg == null ? 1 : 0),
        0,
      ),
    ],
    ["Altitude", countNull((sample) => sample.altitudeM)],
    ["Airspeed", countNull((sample) => sample.airspeedMps)],
    ["Ground speed", countNull((sample) => sample.groundSpeedMps)],
    ["Vertical speed", countNull((sample) => sample.verticalSpeedMps)],
    ["On-ground status", countNull((sample) => sample.onGround)],
  ] as const;
}

export default function PostFlightReport({ sessionId }: { sessionId: string }) {
  const [loadState, setLoadState] = useState<ReportLoadState>({
    sessionId,
    state: "loading",
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadFlightReportBundle(sessionId)
      .then((result) => {
        if (!active) return;
        setLoadState({ sessionId, state: "ready", bundle: result });
        setSelectedIndex(0);
        setPlaying(false);
      })
      .catch((cause: unknown) => {
        if (active)
          setLoadState({
            sessionId,
            state: "error",
            error:
              cause instanceof Error
                ? cause.message
                : "Could not load the saved flight report.",
          });
      });
    return () => {
      active = false;
    };
  }, [sessionId]);

  const bundle =
    loadState.sessionId === sessionId && loadState.state === "ready"
      ? loadState.bundle
      : null;
  const error =
    loadState.sessionId === sessionId && loadState.state === "error"
      ? loadState.error
      : null;
  const loading =
    loadState.sessionId !== sessionId || loadState.state === "loading";
  const samples = useMemo(() => bundle?.telemetry ?? [], [bundle]);
  const isPlaying =
    playing && samples.length > 1 && selectedIndex < samples.length - 1;

  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setTimeout(() => {
      setSelectedIndex((current) => Math.min(current + 1, samples.length - 1));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [isPlaying, samples.length, selectedIndex]);

  const selectedSample = samples.length
    ? samples[Math.min(selectedIndex, samples.length - 1)]
    : null;

  const retry = async () => {
    setLoadState({ sessionId, state: "loading" });
    try {
      const result = await loadFlightReportBundle(sessionId);
      setLoadState({ sessionId, state: "ready", bundle: result });
      setSelectedIndex(0);
      setPlaying(false);
    } catch (cause) {
      setLoadState({
        sessionId,
        state: "error",
        error:
          cause instanceof Error
            ? cause.message
            : "Could not load the saved flight report.",
      });
    }
  };

  const retrySqliteSync = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      await retryDemoFlightSqliteArchive(sessionId);
      const result = await loadFlightReportBundle(sessionId);
      setLoadState({ sessionId, state: "ready", bundle: result });
    } catch (cause) {
      setSyncError(
        cause instanceof Error
          ? cause.message
          : "Could not copy this demo to the SQLite archive.",
      );
    } finally {
      setSyncing(false);
    }
  };

  return (
    <main className="dashboard-shell">
      <AeroTraceHeader />
      <div className="report-shell">
        <div className="report-top-actions">
          <Link href="/" className="text-link">
            <ArrowLeft size={14} /> RECORDER
          </Link>
          <Link href="/flights" className="text-link">
            FLIGHT HISTORY <span aria-hidden="true">↗</span>
          </Link>
        </div>
        {loading && (
          <section className="report-loading" role="status">
            <RefreshCw size={19} className="spin-icon" />
            <span>
              {IS_PUBLIC_DEMO_MODE
                ? "LOADING SAMPLE FLIGHT RECORD"
                : "LOADING PERSISTED FLIGHT RECORD"}
            </span>
            <small>
              {IS_PUBLIC_DEMO_MODE
                ? "Preparing sample session, analysis and telemetry."
                : "Retrieving the saved session, analysis and telemetry pages."}
            </small>
          </section>
        )}
        {error && !loading && (
          <section className="report-load-error" role="alert">
            <AlertTriangle size={20} />
            <div>
              <strong>FLIGHT REPORT UNAVAILABLE</strong>
              <span>{error}</span>
            </div>
            <button type="button" onClick={() => void retry()}>
              <RefreshCw size={14} /> RETRY
            </button>
          </section>
        )}
        {bundle && !loading && (
          <>
            <section className="report-hero">
              <div className="report-hero-copy">
                <span className="eyebrow">
                  POST-FLIGHT DEBRIEF ·{" "}
                  {sourceLabel(bundle.report.session.source)}
                </span>
                <div className="report-title-row">
                  <div>
                    <h1>Flight record</h1>
                    <p className="report-session-id">
                      SESSION {bundle.report.session.sessionId.toUpperCase()}
                    </p>
                  </div>
                  <span
                    className={`report-status status-${bundle.report.recordingStatus}`}
                  >
                    {bundle.report.recordingStatus === "complete" ? (
                      <Check size={13} />
                    ) : (
                      <AlertTriangle size={13} />
                    )}
                    {statusLabel(bundle.report.recordingStatus)}
                  </span>
                </div>
                <div className="report-meta-grid">
                  <div>
                    <span>RECORDING DATE · UTC</span>
                    <strong>
                      {formatUtc(bundle.report.session.startedAt)}
                    </strong>
                  </div>
                  <div>
                    <span>AIRCRAFT</span>
                    <strong>
                      {bundle.report.session.aircraft ?? "Unavailable"}
                    </strong>
                  </div>
                  <div>
                    <span>DEPARTURE</span>
                    <strong>Not identified from recorded data</strong>
                  </div>
                  <div>
                    <span>DESTINATION</span>
                    <strong>Not identified from recorded data</strong>
                  </div>
                </div>
              </div>
              <div className="report-duration-block">
                <span>RECORDING DURATION</span>
                <strong>
                  {formatDuration(
                    bundle.report.summary.recordingDurationSeconds,
                  )}
                </strong>
                <small>
                  {bundle.report.summary.recordingDurationStatus.toUpperCase()}{" "}
                  · WALL-CLOCK SPAN
                </small>
              </div>
            </section>

            {bundle.report.session.source === "demo" && (
              <div className="report-demo-banner" role="status">
                <AlertTriangle size={15} />
                <strong>SYNTHETIC DEMO SESSION</strong>
                <span>
                  These values are generated demo telemetry, not an MSFS
                  recording.
                </span>
              </div>
            )}
            {bundle.report.session.source === "demo" &&
              bundle.archive?.storage === "browser" &&
              bundle.archive.syncWarning && (
                <div className="report-warning" role="status">
                  <AlertTriangle size={15} />
                  <span>{syncError ?? bundle.archive.syncWarning}</span>
                  <button
                    type="button"
                    className="error-retry-button"
                    onClick={() => void retrySqliteSync()}
                    disabled={syncing}
                  >
                    {syncing ? "COPYING…" : "RETRY SQLITE COPY"}
                  </button>
                </div>
              )}
            {bundle.report.recordingStatus === "interrupted" && (
              <div className="report-warning" role="status">
                <AlertTriangle size={15} />
                <span>
                  This recording was interrupted before it could be finalized.
                  The saved samples remain available; its duration may be
                  partial.
                </span>
              </div>
            )}
            {bundle.report.recordingStatus === "active" && (
              <div className="report-warning" role="status">
                <AlertTriangle size={15} />
                <span>
                  This session is still active. Its report is a point-in-time
                  view of saved telemetry.
                </span>
              </div>
            )}

            <section className="report-section" aria-labelledby="summary-title">
              <div className="report-section-heading">
                <div>
                  <span className="eyebrow">CALCULATED FROM SAVED SAMPLES</span>
                  <h2 id="summary-title">Flight summary</h2>
                </div>
                <span className="source-chip">
                  INPUT · {bundle.report.summary.inputProvenance.toUpperCase()}
                </span>
              </div>
              <div className="summary-metrics-grid">
                <SummaryMetric
                  label="RECORDED ROUTE"
                  value={
                    bundle.report.summary.routeDistanceStatus ===
                    "no_valid_segments"
                      ? "Unavailable"
                      : metric(
                          bundle.report.summary.routeDistanceM,
                          "NM",
                          1 / 1852,
                          1,
                        )
                  }
                  detail="Observed segments only"
                />
                <SummaryMetric
                  label="MAXIMUM ALTITUDE"
                  value={metric(
                    bundle.report.summary.maximumAltitudeM,
                    "FT MSL",
                    3.28084,
                  )}
                />
                <SummaryMetric
                  label="MAXIMUM AIRSPEED"
                  value={metric(
                    bundle.report.summary.maximumAirspeedMps,
                    "KT",
                    1.94384,
                  )}
                />
                <SummaryMetric
                  label="MAXIMUM GROUND SPEED"
                  value={metric(
                    bundle.report.summary.maximumGroundSpeedMps,
                    "KT",
                    1.94384,
                  )}
                />
                <SummaryMetric
                  label="AVERAGE GROUND SPEED"
                  value={metric(
                    bundle.report.summary.averageGroundSpeedMps,
                    "KT",
                    1.94384,
                  )}
                  detail="Mean of available ground-speed samples"
                />
                <SummaryMetric
                  label="MAXIMUM CLIMB"
                  value={metric(
                    bundle.report.summary.maximumClimbRateMps,
                    "FT/MIN",
                    196.8504,
                  )}
                />
                <SummaryMetric
                  label="MAXIMUM DESCENT"
                  value={metric(
                    bundle.report.summary.maximumDescentRateMps,
                    "FT/MIN",
                    196.8504,
                  )}
                  detail="Magnitude"
                />
                <SummaryMetric
                  label="AIRBORNE DURATION"
                  value={formatDuration(
                    bundle.report.summary.airborneDurationSeconds,
                  )}
                  detail={`${bundle.report.summary.airborneDurationStatus.toUpperCase()} · ON-GROUND TRANSITIONS`}
                />
              </div>
              <div className="report-quality-strip">
                <div>
                  <span>RECORDING SAMPLES</span>
                  <strong>
                    {bundle.report.summary.sampleCount.toLocaleString()}
                  </strong>
                </div>
                <div>
                  <span>APPROX. SAMPLE COVERAGE</span>
                  <strong>
                    {bundle.report.summary.sampleCoveragePercent == null
                      ? "Unavailable"
                      : `${bundle.report.summary.sampleCoveragePercent.toFixed(1)}%`}
                  </strong>
                </div>
                <div>
                  <span>POSITION COVERAGE</span>
                  <strong>
                    {bundle.report.summary.positionCoveragePercent == null
                      ? "Unavailable"
                      : `${bundle.report.summary.positionCoveragePercent.toFixed(1)}%`}
                  </strong>
                </div>
                <div>
                  <span>ROUTE GAPS</span>
                  <strong>
                    {bundle.report.summary.routeGapCount.toLocaleString()}
                  </strong>
                </div>
              </div>
              <div className="phase-summary">
                <div className="phase-summary-heading">
                  <span>CLASSIFIED PHASE TIME</span>
                  <small>
                    Sum of observed intervals up to 30 seconds apart
                  </small>
                </div>
                <div className="phase-summary-grid">
                  {PHASE_ORDER.map((phase) => (
                    <div key={phase}>
                      <span>{phase.replaceAll("_", " ").toUpperCase()}</span>
                      <strong>
                        {bundle.report.summary.phaseTimeSeconds[phase] == null
                          ? "Unavailable"
                          : formatDuration(
                              bundle.report.summary.phaseTimeSeconds[phase],
                            )}
                      </strong>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section
              className="report-section replay-section"
              aria-labelledby="replay-title"
            >
              <div className="report-section-heading">
                <div>
                  <span className="eyebrow">
                    SAVED TELEMETRY · {samples.length.toLocaleString()} SAMPLES
                  </span>
                  <h2 id="replay-title">Route replay</h2>
                </div>
                <span className="chart-sample-count">
                  {selectedSample
                    ? formatUtc(selectedSample.timestamp)
                    : "NO TELEMETRY SAMPLES"}
                </span>
              </div>
              <FlightReplayMap
                analysis={bundle.analysis}
                selectedSample={selectedSample}
              />
              <div className="replay-console">
                <button
                  type="button"
                  className="playback-button"
                  onClick={() => {
                    if (isPlaying) setPlaying(false);
                    else {
                      if (selectedIndex >= samples.length - 1)
                        setSelectedIndex(0);
                      setPlaying(true);
                    }
                  }}
                  disabled={samples.length < 2}
                  aria-label={
                    isPlaying ? "Pause route playback" : "Play route playback"
                  }
                >
                  {isPlaying ? <Pause size={15} /> : <Play size={15} />}
                  {isPlaying ? "PAUSE" : "PLAY"}
                </button>
                <div className="playback-range-wrap">
                  <label htmlFor="flight-playback-range">
                    RECORDED TIMELINE
                  </label>
                  <input
                    id="flight-playback-range"
                    type="range"
                    min={0}
                    max={Math.max(0, samples.length - 1)}
                    value={
                      samples.length
                        ? Math.min(selectedIndex, samples.length - 1)
                        : 0
                    }
                    onChange={(event) => {
                      setPlaying(false);
                      setSelectedIndex(Number(event.target.value));
                    }}
                    disabled={samples.length === 0}
                  />
                  <div className="playback-time-labels">
                    <span>
                      {samples.length
                        ? formatUtc(samples[0].timestamp)
                        : "Unavailable"}
                    </span>
                    <span>
                      {selectedSample
                        ? `SELECTED · ${formatUtc(selectedSample.timestamp)}`
                        : "NO SELECTED SAMPLE"}
                    </span>
                    <span>
                      {samples.length
                        ? formatUtc(samples.at(-1)!.timestamp)
                        : "Unavailable"}
                    </span>
                  </div>
                </div>
                <div className="playback-values">
                  <span>
                    ALT{" "}
                    <strong>
                      {selectedSample?.altitudeM == null
                        ? "—"
                        : `${Math.round(selectedSample.altitudeM * 3.28084).toLocaleString()} FT`}
                    </strong>
                  </span>
                  <span>
                    IAS{" "}
                    <strong>
                      {selectedSample?.airspeedMps == null
                        ? "—"
                        : `${Math.round(selectedSample.airspeedMps * 1.94384)} KT`}
                    </strong>
                  </span>
                  <span>
                    GS{" "}
                    <strong>
                      {selectedSample?.groundSpeedMps == null
                        ? "—"
                        : `${Math.round(selectedSample.groundSpeedMps * 1.94384)} KT`}
                    </strong>
                  </span>
                  <span>
                    V/S{" "}
                    <strong>
                      {selectedSample?.verticalSpeedMps == null
                        ? "—"
                        : `${Math.round(selectedSample.verticalSpeedMps * 196.8504).toLocaleString()} FPM`}
                    </strong>
                  </span>
                </div>
              </div>
            </section>

            <FlightReportCharts
              samples={samples}
              selectedSample={selectedSample}
            />
            <FlightReportTimeline analysis={bundle.analysis} />

            <section
              className="report-section data-quality-section"
              aria-labelledby="quality-title"
            >
              <div className="report-section-heading">
                <div>
                  <span className="eyebrow">PROVENANCE & LIMITATIONS</span>
                  <h2 id="quality-title">Data quality</h2>
                </div>
                <span className="source-chip">
                  {bundle.report.summary.calculationSource
                    .replaceAll("_", " ")
                    .toUpperCase()}
                </span>
              </div>
              <p className="quality-intro">
                The report uses persisted{" "}
                {bundle.report.summary.inputProvenance === "observed"
                  ? "simulator-observed"
                  : bundle.report.summary.inputProvenance === "calculated"
                    ? "synthetic calculated"
                    : bundle.report.summary.inputProvenance}{" "}
                telemetry. Missing measurements are retained as unavailable;
                they are not filled or interpolated.
              </p>
              <div className="missing-data-grid">
                {emptyCounts(samples).map(([label, count]) => (
                  <div key={label}>
                    <span>MISSING {label.toUpperCase()}</span>
                    <strong>
                      {count.toLocaleString()} /{" "}
                      {samples.length.toLocaleString()}
                    </strong>
                  </div>
                ))}
              </div>
              <ul className="quality-notes">
                <li>
                  {bundle.report.summary.routeGapCount.toLocaleString()} route
                  gaps over the backend 30-second threshold are excluded from
                  route distance; no connecting path is drawn across them.
                </li>
                <li>
                  Recording duration is the persisted wall-clock span. Airborne
                  duration is separate and is available only from observed
                  on-ground transitions.
                </li>
                <li>
                  Airport identification, touchdown vertical speed and landing
                  quality are not calculated from the available data.
                </li>
                <li>
                  Invalid telemetry fields are rejected by connector validation;
                  rejected-sample counts are not currently exposed by the API.
                </li>
                {bundle.report.summary.duplicateTimestampCount > 0 && (
                  <li>
                    {bundle.report.summary.duplicateTimestampCount.toLocaleString()}{" "}
                    same-timestamp samples were excluded from analysis
                    calculations; stored history remains available.
                  </li>
                )}
              </ul>
              <div className="route-endpoints">
                <div>
                  <span>FIRST VALID POSITION</span>
                  <strong>
                    {coordinate(
                      bundle.report.summary.firstPosition?.latitudeDeg,
                      bundle.report.summary.firstPosition?.longitudeDeg,
                    )}
                  </strong>
                  <small>
                    {formatUtc(bundle.report.summary.firstPosition?.timestamp)}
                  </small>
                </div>
                <div>
                  <span>LAST VALID POSITION</span>
                  <strong>
                    {coordinate(
                      bundle.report.summary.lastPosition?.latitudeDeg,
                      bundle.report.summary.lastPosition?.longitudeDeg,
                    )}
                  </strong>
                  <small>
                    {formatUtc(bundle.report.summary.lastPosition?.timestamp)}
                  </small>
                </div>
              </div>
            </section>
          </>
        )}
        <footer className="report-footer">
          <span>
            {IS_PUBLIC_DEMO_MODE
              ? "AEROTRACE · SAMPLE FLIGHT DEBRIEF"
              : "AEROTRACE · LOCAL FLIGHT DEBRIEF"}
          </span>
          <Link href="/flights" className="text-link">
            OPEN FLIGHT HISTORY <span aria-hidden="true">↗</span>
          </Link>
        </footer>
      </div>
    </main>
  );
}
