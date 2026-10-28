"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Circle,
  Clock3,
  Compass,
  Gauge,
  MapPinned,
  Pause,
  Play,
  Radio,
  Signal,
  WifiOff,
} from "lucide-react";
import EventTimeline from "@/components/event-timeline";
import AeroTraceHeader from "@/components/aerotrace-header";
import FlightCharts from "@/components/flight-charts";
import RouteMap from "@/components/route-map";
import { ConnectorStatusSchema, TelemetrySampleSchema } from "@/lib/contracts";
import { DEMO_PRIMARY_BUNDLE, DEMO_PRIMARY_STATUS } from "@/lib/demo-data";
import {
  claimFlightAction,
  archiveDemoFlightToConnector,
  FLIGHT_API_BASE,
  FLIGHT_API_CONFIGURATION_ERROR,
  fetchFlightTelemetryWindow,
  finalizeFlight,
  IS_PUBLIC_DEMO_MODE,
  loadFlightReportBundle,
  requestLocalConnector,
} from "@/lib/flight-api";
import { mergeLiveSamples } from "@/lib/live-telemetry";
import { saveDemoArchiveEntry } from "@/lib/demo-archive";
import {
  buildDemoReportBundle,
  createDemoSample,
  createDemoSession,
  DEMO_FLIGHT_DURATION_SECONDS,
} from "@/lib/demo-recorder";
import type {
  ConnectorStatus,
  FlightLifecycleState,
  TelemetrySample,
} from "@/lib/contracts";

const WS_URL = FLIGHT_API_BASE.replace(/^http/, "ws");
const EMPTY_STATUS: ConnectorStatus = {
  state: "disconnected",
  source: null,
  selectedSource: "demo",
  simulator: { state: "not_detected", message: null, paused: false },
  session: null,
  message: null,
};

type PendingAction = "starting" | "completing" | null;
type StreamState = "idle" | "connecting" | "live" | "reconnecting";

const lifecycleLabels: Record<FlightLifecycleState, string> = {
  disconnected: "DISCONNECTED",
  connected: "CONNECTED",
  recording: "RECORDING",
  finalizing: "FINALIZING",
  completed: "COMPLETED",
  interrupted: "INTERRUPTED",
  error: "ERROR",
};

function parseStatus(payload: unknown): ConnectorStatus {
  return ConnectorStatusSchema.parse(payload);
}

async function responsePayload(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function parseError(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null && "detail" in payload) {
    const detail = payload.detail;
    if (typeof detail === "string") return detail;
  }
  return fallback;
}

const speedKnots = (mps: number | null | undefined) =>
  mps == null ? "—" : Math.round(mps * 1.94384).toLocaleString();
const altitudeFeet = (metres: number | null | undefined) =>
  metres == null ? "—" : Math.round(metres * 3.28084).toLocaleString();
const verticalFpm = (mps: number | null | undefined) =>
  mps == null ? "—" : Math.round(mps * 196.8504).toLocaleString();
const degrees = (value: number | null | undefined) =>
  value == null ? "—" : `${Math.round(value).toString().padStart(3, "0")}°`;
const coordinate = (value: number | null | undefined) =>
  value == null ? "—" : value.toFixed(4);

export default function FlightDashboard() {
  const router = useRouter();
  const [status, setStatus] = useState<ConnectorStatus>(
    IS_PUBLIC_DEMO_MODE ? DEMO_PRIMARY_STATUS : EMPTY_STATUS,
  );
  const [connectorOnline, setConnectorOnline] = useState(IS_PUBLIC_DEMO_MODE);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [samples, setSamples] = useState<TelemetrySample[]>(
    IS_PUBLIC_DEMO_MODE ? DEMO_PRIMARY_BUNDLE.telemetry : [],
  );
  const [pending, setPending] = useState<PendingAction>(null);
  const [completionRetry, setCompletionRetry] = useState<{
    sessionId: string;
    confirmed: boolean;
  } | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("idle");
  const [demoPaused, setDemoPaused] = useState(false);
  const [demoSessionLocal, setDemoSessionLocal] = useState(false);
  const pendingRef = useRef(false);
  const connectorOnlineRef = useRef(IS_PUBLIC_DEMO_MODE);
  const revisionRef = useRef(0);
  const sessionRef = useRef<string | null>(null);
  const demoSessionRef = useRef<ConnectorStatus["session"]>(null);
  const demoSamplesRef = useRef<TelemetrySample[]>([]);
  const demoElapsedRef = useRef(0);
  const demoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const demoWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const localDemoRef = useRef(false);

  useEffect(
    () => () => {
      if (demoTimerRef.current) clearInterval(demoTimerRef.current);
    },
    [],
  );

  const applyStatus = useCallback((next: ConnectorStatus) => {
    const nextSessionId = next.session?.sessionId ?? null;
    if (sessionRef.current !== nextSessionId) {
      sessionRef.current = nextSessionId;
      setSamples([]);
    }
    setStatus(next);
  }, []);

  const refreshStatus = useCallback(
    async (signal?: AbortSignal) => {
      if (IS_PUBLIC_DEMO_MODE) return;
      if (pendingRef.current) return;
      if (FLIGHT_API_CONFIGURATION_ERROR) {
        connectorOnlineRef.current = false;
        setConnectorOnline(false);
        setConnectionError(FLIGHT_API_CONFIGURATION_ERROR);
        return;
      }
      const revision = revisionRef.current;
      try {
        const response = await requestLocalConnector("/api/status", {
          cache: "no-store",
          signal,
        });
        if (!response.ok)
          throw new Error(`Connector returned ${response.status}`);
        const parsed = parseStatus(await responsePayload(response));
        if (revision !== revisionRef.current || pendingRef.current) return;
        if (localDemoRef.current) {
          connectorOnlineRef.current = true;
          setConnectorOnline(true);
          setConnectionError(null);
          return;
        }
        applyStatus(parsed);
        connectorOnlineRef.current = true;
        setConnectorOnline(true);
        setConnectionError(null);
      } catch (error) {
        if (
          signal?.aborted ||
          revision !== revisionRef.current ||
          pendingRef.current
        )
          return;
        setConnectorOnline(false);
        connectorOnlineRef.current = false;
        setConnectionError(
          error instanceof Error
            ? `Local connector unavailable · ${error.message}`
            : "Local connector unavailable",
        );
      }
    },
    [applyStatus],
  );

  useEffect(() => {
    if (IS_PUBLIC_DEMO_MODE) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const controller = new AbortController();
    const poll = async () => {
      await refreshStatus(controller.signal);
      if (active) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      active = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [refreshStatus]);

  const sessionId = status.session?.sessionId ?? null;
  const sessionSource = status.session?.source;
  const sessionSampleCount = status.session?.sampleCount;
  useEffect(() => {
    if (
      IS_PUBLIC_DEMO_MODE ||
      !connectorOnline ||
      !sessionId ||
      !sessionSource ||
      sessionSampleCount == null ||
      status.state === "recording" ||
      status.state === "finalizing"
    ) {
      return;
    }
    const controller = new AbortController();
    const loadHistory = async () => {
      try {
        const history = await fetchFlightTelemetryWindow(
          sessionId,
          sessionSource,
          sessionSampleCount,
          fetch,
          controller.signal,
        );
        if (!controller.signal.aborted)
          setSamples((current) => mergeLiveSamples(current, history));
      } catch (error) {
        if (!controller.signal.aborted) {
          setOperationError(
            error instanceof Error
              ? `Could not load recorded telemetry · ${error.message}`
              : "Could not load recorded telemetry",
          );
        }
      }
    };
    void loadHistory();
    return () => controller.abort();
  }, [
    connectorOnline,
    sessionId,
    sessionSampleCount,
    sessionSource,
    status.state,
  ]);

  useEffect(() => {
    if (
      IS_PUBLIC_DEMO_MODE ||
      localDemoRef.current ||
      status.state !== "recording" ||
      !sessionId ||
      !status.source
    ) {
      return;
    }

    let cancelled = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1000;
    let syncPromise: Promise<void> | null = null;
    const synchronizeSamples = () => {
      if (syncPromise) return syncPromise;
      syncPromise = (async () => {
        try {
          const response = await requestLocalConnector("/api/status", {
            cache: "no-store",
          });
          if (!response.ok)
            throw new Error(`Connector returned ${response.status}`);
          const latestStatus = parseStatus(await responsePayload(response));
          if (cancelled) return;
          if (
            latestStatus.session?.sessionId !== sessionId ||
            latestStatus.session.source !== status.source ||
            latestStatus.state !== "recording"
          ) {
            applyStatus(latestStatus);
            return;
          }
          const history = await fetchFlightTelemetryWindow(
            sessionId,
            status.source,
            latestStatus.session.sampleCount,
            fetch,
          );
          if (!cancelled)
            setSamples((current) => mergeLiveSamples(current, history));
        } catch (error) {
          if (!cancelled) {
            setOperationError(
              error instanceof Error
                ? `Could not synchronize recent telemetry · ${error.message}`
                : "Could not synchronize recent telemetry",
            );
          }
        } finally {
          syncPromise = null;
        }
      })();
      return syncPromise;
    };

    const connect = () => {
      if (cancelled) return;
      setStreamState(retryDelay === 1000 ? "connecting" : "reconnecting");
      const currentSocket = new WebSocket(`${WS_URL}/ws/telemetry`);
      socket = currentSocket;
      currentSocket.onopen = () => {
        if (cancelled) return;
        setStreamState("live");
        retryDelay = 1000;
        void synchronizeSamples();
      };
      currentSocket.onmessage = (event) => {
        let payload: unknown;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          setOperationError(
            "The connector sent an unreadable telemetry message.",
          );
          return;
        }
        const parsed = TelemetrySampleSchema.safeParse(payload);
        if (!parsed.success) {
          setOperationError(
            "A telemetry message did not match the supported data contract.",
          );
          return;
        }
        const sample = parsed.data;
        if (
          cancelled ||
          pendingRef.current ||
          sample.sessionId !== sessionId ||
          sample.source !== status.source
        )
          return;
        setSamples((current) => mergeLiveSamples(current, [sample]));
      };
      currentSocket.onerror = () => currentSocket.close();
      currentSocket.onclose = () => {
        if (cancelled) return;
        setStreamState("reconnecting");
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10_000);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }
    };
  }, [applyStatus, sessionId, status.source, status.state]);

  const clearDemoTimer = () => {
    if (demoTimerRef.current) {
      clearInterval(demoTimerRef.current);
      demoTimerRef.current = null;
    }
  };

  const reportDemoPersistenceError = (error: unknown) => {
    clearDemoTimer();
    setDemoPaused(true);
    const message =
      error instanceof Error
        ? `Demo archive could not be saved · ${error.message}`
        : "Demo archive could not be saved.";
    setOperationError(message);
    setStatus((current) => ({
      ...current,
      state: "error",
      session: current.session
        ? { ...current.session, state: "error", error: message }
        : null,
    }));
  };

  const queueDemoArchiveWrite = (
    session: NonNullable<ConnectorStatus["session"]>,
    telemetry: TelemetrySample[],
  ) => {
    demoWriteQueueRef.current = demoWriteQueueRef.current.then(() =>
      saveDemoArchiveEntry({ session, telemetry, bundle: null }),
    );
    void demoWriteQueueRef.current.catch(reportDemoPersistenceError);
  };

  const finishLocalDemo = async () => {
    const activeSession = demoSessionRef.current;
    if (
      !activeSession ||
      activeSession.source !== "demo" ||
      activeSession.state === "completed" ||
      pendingRef.current
    )
      return;
    pendingRef.current = true;
    clearDemoTimer();
    setDemoPaused(false);
    setPending("completing");
    setOperationError(null);
    setStatus((current) => ({
      ...current,
      state: "finalizing",
      session:
        activeSession.state === "error"
          ? { ...activeSession, state: "finalizing", error: null }
          : { ...activeSession, state: "finalizing" },
    }));
    try {
      await demoWriteQueueRef.current;
      const completedAt = new Date().toISOString();
      const completedSession = {
        ...activeSession,
        state: "completed" as const,
        completedAt,
        sampleCount: demoSamplesRef.current.length,
        error: null,
      };
      let bundle = buildDemoReportBundle(
        completedSession,
        demoSamplesRef.current,
      );
      bundle = {
        ...bundle,
        archive: {
          storage: "browser",
          syncWarning: connectorOnlineRef.current
            ? undefined
            : "Connector was offline; this copy is safe in the browser archive. Start the connector and retry the SQLite copy here.",
        },
      };
      await saveDemoArchiveEntry({
        session: completedSession,
        telemetry: demoSamplesRef.current,
        bundle,
      });
      if (connectorOnlineRef.current) {
        try {
          await archiveDemoFlightToConnector(bundle);
          bundle = { ...bundle, archive: { storage: "browser+sqlite" } };
          await saveDemoArchiveEntry({
            session: completedSession,
            telemetry: demoSamplesRef.current,
            bundle,
          });
        } catch (error) {
          bundle = {
            ...bundle,
            archive: {
              storage: "browser",
              syncWarning:
                error instanceof Error
                  ? `Browser copy saved; SQLite sync failed · ${error.message}`
                  : "Browser copy saved; SQLite sync failed.",
            },
          };
          await saveDemoArchiveEntry({
            session: completedSession,
            telemetry: demoSamplesRef.current,
            bundle,
          });
        }
      }
      demoSessionRef.current = completedSession;
      setStatus((current) => ({
        ...current,
        state: "completed",
        source: "demo",
        selectedSource: "demo",
        session: completedSession,
        message: null,
      }));
      localDemoRef.current = false;
      setDemoSessionLocal(false);
      router.push(`/flights/${completedSession.sessionId}`);
    } catch (error) {
      reportDemoPersistenceError(error);
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  const startDemoTimer = () => {
    clearDemoTimer();
    demoTimerRef.current = setInterval(() => {
      if (pendingRef.current) return;
      const currentSession = demoSessionRef.current;
      if (!currentSession || currentSession.state === "completed") {
        clearDemoTimer();
        return;
      }
      const elapsed = Math.min(
        demoElapsedRef.current + 1,
        DEMO_FLIGHT_DURATION_SECONDS,
      );
      demoElapsedRef.current = elapsed;
      const sample = createDemoSample(currentSession.sessionId, elapsed);
      const nextSamples = [...demoSamplesRef.current, sample];
      demoSamplesRef.current = nextSamples;
      const nextSession = {
        ...currentSession,
        state: "recording" as const,
        sampleCount: nextSamples.length,
        error: null,
      };
      demoSessionRef.current = nextSession;
      setSamples(nextSamples);
      setStatus((current) => ({
        ...current,
        state: "recording",
        source: "demo",
        selectedSource: "demo",
        session: nextSession,
        message: null,
      }));
      queueDemoArchiveWrite(nextSession, nextSamples);
      if (elapsed >= DEMO_FLIGHT_DURATION_SECONDS) {
        void finishLocalDemo();
      }
    }, 1000);
  };

  const startDemoFlight = async () => {
    if (IS_PUBLIC_DEMO_MODE || pendingRef.current) return;
    if (
      status.state === "recording" ||
      status.state === "finalizing" ||
      localDemoRef.current
    )
      return;
    pendingRef.current = true;
    setPending("starting");
    setOperationError(null);
    clearDemoTimer();
    try {
      const session = createDemoSession();
      const firstSample = createDemoSample(session.sessionId, 0);
      const recordingSession = { ...session, sampleCount: 1 };
      const firstSamples = [firstSample];
      await saveDemoArchiveEntry({
        session: recordingSession,
        telemetry: firstSamples,
        bundle: null,
      });
      localDemoRef.current = true;
      setDemoSessionLocal(true);
      demoSessionRef.current = recordingSession;
      demoSamplesRef.current = firstSamples;
      demoElapsedRef.current = 0;
      demoWriteQueueRef.current = Promise.resolve();
      sessionRef.current = session.sessionId;
      setSamples(firstSamples);
      setDemoPaused(false);
      setStatus({
        ...EMPTY_STATUS,
        state: "recording",
        source: "demo",
        selectedSource: "demo",
        session: recordingSession,
      });
      startDemoTimer();
    } catch (error) {
      setOperationError(
        error instanceof Error
          ? `Could not start demo flight · ${error.message}`
          : "Could not start demo flight.",
      );
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  const pauseDemoFlight = () => {
    if (!localDemoRef.current || demoPaused || status.state !== "recording")
      return;
    clearDemoTimer();
    setDemoPaused(true);
  };

  const resumeDemoFlight = () => {
    if (!localDemoRef.current || !demoPaused || status.state !== "recording")
      return;
    setDemoPaused(false);
    startDemoTimer();
  };

  const startFlight = async () => {
    if (IS_PUBLIC_DEMO_MODE || pendingRef.current) return;
    if (status.selectedSource === "demo") {
      await startDemoFlight();
      return;
    }
    if (!connectorOnline) return;
    pendingRef.current = true;
    revisionRef.current += 1;
    setPending("starting");
    setOperationError(null);
    let failed = false;
    try {
      const response = await requestLocalConnector("/api/flights/start", {
        method: "POST",
      });
      const payload = await responsePayload(response);
      if (!response.ok)
        throw new Error(parseError(payload, "Could not start flight"));
      const parsed = parseStatus(payload);
      if (
        parsed.state !== "recording" ||
        parsed.source !== parsed.selectedSource ||
        !parsed.session
      ) {
        throw new Error(
          "Connector did not confirm the selected recording source.",
        );
      }
      applyStatus(parsed);
      connectorOnlineRef.current = true;
      setConnectorOnline(true);
      setConnectionError(null);
    } catch (error) {
      failed = true;
      setOperationError(
        error instanceof Error ? error.message : "Could not start flight",
      );
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
    if (failed) void refreshStatus();
  };

  const selectProvider = async (source: "demo" | "simconnect") => {
    if (
      IS_PUBLIC_DEMO_MODE ||
      pendingRef.current ||
      status.state === "recording"
    )
      return;
    if (!connectorOnline) {
      setOperationError(null);
      setStatus((current) => ({ ...current, selectedSource: source }));
      return;
    }
    pendingRef.current = true;
    setOperationError(null);
    try {
      const response = await requestLocalConnector(
        `/api/provider/select/${source}`,
        { method: "POST" },
      );
      const payload = await responsePayload(response);
      if (!response.ok)
        throw new Error(
          parseError(payload, `Could not select ${source} provider`),
        );
      applyStatus(parseStatus(payload));
    } catch (error) {
      setOperationError(
        error instanceof Error
          ? error.message
          : `Could not select ${source} provider`,
      );
      void refreshStatus();
    } finally {
      pendingRef.current = false;
    }
  };

  const completeFlight = async (
    retry: { sessionId: string; confirmed: boolean } | null = null,
  ) => {
    if (IS_PUBLIC_DEMO_MODE) return;
    if (localDemoRef.current && status.session?.source === "demo" && !retry) {
      await finishLocalDemo();
      return;
    }
    const sessionId = retry?.sessionId ?? status.session?.sessionId;
    if (!sessionId || pendingRef.current) return;
    if (!retry && (!connectorOnline || status.state !== "recording")) return;
    if (!claimFlightAction(pendingRef)) return;
    revisionRef.current += 1;
    setPending("completing");
    setOperationError(null);
    if (!retry) {
      setStatus((current) => ({
        ...current,
        state: "finalizing",
        session: current.session
          ? { ...current.session, state: "finalizing" }
          : null,
      }));
    }
    let failed = false;
    let completionConfirmed = retry?.confirmed ?? false;
    try {
      if (!completionConfirmed) {
        const confirmed = await finalizeFlight(sessionId);
        if (confirmed.session?.sessionId !== sessionId) {
          throw new Error(
            "The connector finalized a different flight session.",
          );
        }
        applyStatus(confirmed);
        completionConfirmed = true;
        setCompletionRetry({ sessionId, confirmed: true });
      }

      const savedBundle = await loadFlightReportBundle(sessionId);
      if (
        savedBundle.report.recordingStatus !== "complete" ||
        savedBundle.report.session.completedAt == null
      ) {
        throw new Error("The saved report did not confirm a completed flight.");
      }
      setCompletionRetry(null);
      connectorOnlineRef.current = true;
      setConnectorOnline(true);
      setConnectionError(null);
      router.push(`/flights/${sessionId}`);
    } catch (error) {
      failed = true;
      setCompletionRetry({ sessionId, confirmed: completionConfirmed });
      setOperationError(
        completionConfirmed
          ? `Flight saved, but its report could not be retrieved. ${error instanceof Error ? error.message : "Retry report retrieval."}`
          : error instanceof Error
            ? error.message
            : "Could not complete flight",
      );
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
    if (failed) void refreshStatus();
  };

  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  const totalSampleCount = Math.max(
    status.session?.sampleCount ?? 0,
    samples.length,
  );
  const lifecycle = status.state;
  const visibleStreamState = lifecycle === "recording" ? streamState : "idle";
  const title =
    lifecycle === "recording" && status.source === "demo"
      ? demoPaused
        ? "DEMO PAUSED"
        : "DEMO RECORDING"
      : lifecycleLabels[lifecycle];
  const stateColor =
    lifecycle === "recording" && demoPaused
      ? "#d2ad70"
      : lifecycle === "recording"
        ? "#72c3a0"
        : lifecycle === "completed"
          ? "#78a8bd"
          : lifecycle === "error"
            ? "#df786e"
            : lifecycle === "finalizing"
              ? "#d2ad70"
              : connectorOnline
                ? "#aeb8bf"
                : "#df786e";
  const actionLabel =
    pending === "starting"
      ? "STARTING FLIGHT…"
      : pending === "completing"
        ? "FINALIZING…"
        : lifecycle === "recording"
          ? "COMPLETE FLIGHT"
          : status.selectedSource === "demo"
            ? "START DEMO FLIGHT"
            : "START MSFS FLIGHT";
  const isLocalDemoActive =
    demoSessionLocal &&
    status.source === "demo" &&
    (lifecycle === "recording" || lifecycle === "error");

  return (
    <main className="dashboard-shell">
      <AeroTraceHeader>
        <div className="header-right">
          <div
            className={`connector-indicator ${connectorOnline ? "online" : "offline"}`}
            role="status"
          >
            {IS_PUBLIC_DEMO_MODE ? (
              <>
                <Signal size={14} />
                <span>SAMPLE TELEMETRY</span>
                <strong>READY</strong>
              </>
            ) : (
              <>
                {connectorOnline ? <Signal size={14} /> : <WifiOff size={14} />}
                <span>LOCAL CONNECTOR</span>
                <strong>{connectorOnline ? "ONLINE" : "OFFLINE"}</strong>
              </>
            )}
          </div>
          {!IS_PUBLIC_DEMO_MODE && (
            <>
              <div className="header-divider" />
              <div className="sim-indicator">
                <span className="sim-light" />
                <span>MSFS</span>
                <strong>
                  {status.simulator.paused
                    ? "PAUSED"
                    : status.simulator.state.replaceAll("_", " ").toUpperCase()}
                </strong>
              </div>
            </>
          )}
        </div>
      </AeroTraceHeader>

      <div className="dashboard-content">
        <section className="flight-strip" aria-label="Current flight status">
          <div className="flight-strip-title">
            <span className="eyebrow">FLIGHT OPERATIONS</span>
            <h1>{status.session?.aircraft ?? "Flight recorder"}</h1>
          </div>
          <div className="flight-state-block">
            <Circle size={9} fill={stateColor} color={stateColor} />
            <div>
              <span className="eyebrow">LIFECYCLE</span>
              <strong>{title}</strong>
            </div>
          </div>
          <div className="flight-meta">
            <span className="eyebrow">SESSION</span>
            <strong>
              {status.session?.sessionId.slice(0, 8).toUpperCase() ?? "—"}
            </strong>
          </div>
          <div className="flight-meta">
            <span className="eyebrow">SAMPLES</span>
            <strong>{totalSampleCount.toLocaleString()}</strong>
          </div>
          <div className="flight-meta flight-source">
            <span className="eyebrow">SOURCE</span>
            <strong>
              {status.source === "demo"
                ? "SYNTHETIC · DEMO"
                : status.source === "simconnect"
                  ? "SIMCONNECT"
                  : status.selectedSource === "demo"
                    ? "DEMO · SYNTHETIC"
                    : "MSFS · SIMCONNECT"}
            </strong>
          </div>
          <div className="flight-action">
            {!IS_PUBLIC_DEMO_MODE &&
              lifecycle !== "recording" &&
              lifecycle !== "finalizing" && (
                <div className="provider-choice" aria-label="Telemetry source">
                  <button
                    type="button"
                    aria-pressed={status.selectedSource === "simconnect"}
                    onClick={() => void selectProvider("simconnect")}
                    disabled={pending !== null}
                  >
                    MSFS
                  </button>
                  <button
                    type="button"
                    aria-pressed={status.selectedSource === "demo"}
                    onClick={() => void selectProvider("demo")}
                    disabled={pending !== null}
                  >
                    DEMO
                  </button>
                </div>
              )}
            {IS_PUBLIC_DEMO_MODE ? (
              <span className="demo-readonly-label">READ-ONLY SAMPLE</span>
            ) : isLocalDemoActive ? (
              <div className="demo-controls">
                <button
                  type="button"
                  className="control-button pause"
                  onClick={demoPaused ? resumeDemoFlight : pauseDemoFlight}
                  disabled={pending !== null || lifecycle === "error"}
                  aria-label={
                    demoPaused ? "Resume demo flight" : "Pause demo flight"
                  }
                >
                  {demoPaused ? <Play size={15} /> : <Pause size={15} />}
                  {demoPaused ? "RESUME DEMO" : "PAUSE DEMO"}
                </button>
                <button
                  type="button"
                  className="control-button complete"
                  onClick={() => void completeFlight()}
                  disabled={pending !== null}
                  aria-label="Finish and save demo flight"
                >
                  <Check size={15} /> FINISH DEMO
                </button>
              </div>
            ) : lifecycle === "recording" ? (
              <button
                type="button"
                className="control-button complete"
                onClick={() => void completeFlight()}
                disabled={!connectorOnline || pending !== null}
              >
                <Check size={15} /> {actionLabel}
              </button>
            ) : (
              <button
                type="button"
                className="control-button start"
                onClick={() => void startFlight()}
                disabled={
                  (status.selectedSource === "simconnect" &&
                    !connectorOnline) ||
                  pending !== null ||
                  lifecycle === "finalizing"
                }
              >
                <Radio size={15} /> {actionLabel}
              </button>
            )}
          </div>
        </section>

        {status.source === "demo" &&
          (status.state === "recording" || status.state === "error") && (
            <div className="demo-banner" role="status">
              <AlertTriangle size={15} />
              <strong>{demoPaused ? "DEMO PAUSED" : "SYNTHETIC DATA"}</strong>
              <span>
                {status.state === "error"
                  ? "Demo archive needs attention · no MSFS data is used"
                  : "Synthetic telemetry · not a real MSFS recording"}
              </span>
            </div>
          )}
        {!connectorOnline && (
          <div
            className={
              status.selectedSource === "demo"
                ? "connector-note"
                : "error-banner"
            }
            role={status.selectedSource === "demo" ? "status" : "alert"}
          >
            <WifiOff size={15} />
            <span>
              {status.selectedSource === "demo"
                ? "Local connector offline. Demo flights work independently; MSFS recording requires the connector and simulator."
                : (connectionError ??
                  "The local AeroTrace connector is not responding.")}
            </span>
            <button
              type="button"
              className="error-retry-button"
              onClick={() => void refreshStatus()}
            >
              CHECK CONNECTOR
            </button>
          </div>
        )}
        {(operationError ||
          status.message ||
          (status.selectedSource === "simconnect" &&
            status.simulator.message)) && (
          <div className="error-banner" role="alert">
            <AlertTriangle size={15} />
            <span>
              {operationError ?? status.message ?? status.simulator.message}
            </span>
            {completionRetry && (
              <button
                type="button"
                className="error-retry-button"
                onClick={() => void completeFlight(completionRetry)}
                disabled={pending !== null}
              >
                {pending === "completing"
                  ? "RETRYING…"
                  : completionRetry.confirmed
                    ? "RETRY REPORT"
                    : "RETRY COMPLETION"}
              </button>
            )}
          </div>
        )}

        <div className="primary-grid">
          <RouteMap
            samples={samples}
            sessionId={sessionId}
            state={lifecycle}
            connectorOnline={connectorOnline}
            demoAvailable={!IS_PUBLIC_DEMO_MODE}
          />
          <section
            className="telemetry-panel"
            aria-labelledby="telemetry-title"
          >
            <div className="panel-heading">
              <div>
                <span className="eyebrow">
                  {IS_PUBLIC_DEMO_MODE
                    ? "SAMPLE TELEMETRY"
                    : status.source === "demo"
                      ? "SYNTHETIC TELEMETRY"
                      : "LIVE INSTRUMENTS"}
                </span>
                <h2 id="telemetry-title">Telemetry</h2>
              </div>
              <div className={`stream-indicator ${visibleStreamState}`}>
                <span />{" "}
                {status.source === "demo" && lifecycle === "recording"
                  ? demoPaused
                    ? "DEMO PAUSED"
                    : "SYNTHETIC LIVE"
                  : visibleStreamState === "live"
                    ? "STREAM LIVE"
                    : visibleStreamState === "reconnecting"
                      ? "RECONNECTING"
                      : visibleStreamState === "connecting"
                        ? "CONNECTING"
                        : IS_PUBLIC_DEMO_MODE
                          ? "SAMPLE RECORD"
                          : "STREAM IDLE"}
              </div>
            </div>
            <div className="instrument-primary">
              <div>
                <span className="eyebrow">ALTITUDE</span>
                <div className="instrument-value large">
                  {altitudeFeet(latest?.altitudeM)}
                  <span>FT</span>
                </div>
              </div>
              <div className="instrument-primary-icon">
                <Gauge size={19} />
              </div>
            </div>
            <div className="instrument-grid">
              <Instrument
                label="AIRSPEED"
                value={speedKnots(latest?.airspeedMps)}
                unit="KT"
                icon={<ArrowUp size={13} />}
              />
              <Instrument
                label="GROUND SPEED"
                value={speedKnots(latest?.groundSpeedMps)}
                unit="KT"
                icon={<Activity size={13} />}
              />
              <Instrument
                label="VERTICAL SPEED"
                value={verticalFpm(latest?.verticalSpeedMps)}
                unit="FT/MIN"
                icon={
                  latest?.verticalSpeedMps != null &&
                  latest.verticalSpeedMps < 0 ? (
                    <ArrowDown size={13} />
                  ) : (
                    <ArrowUp size={13} />
                  )
                }
              />
              <Instrument
                label="HEADING"
                value={degrees(latest?.headingDeg)}
                unit="DEG"
                icon={<Compass size={13} />}
              />
              <Instrument
                label="LATITUDE"
                value={coordinate(latest?.latitudeDeg)}
                unit="°"
                icon={<MapPinned size={13} />}
              />
              <Instrument
                label="LONGITUDE"
                value={coordinate(latest?.longitudeDeg)}
                unit="°"
                icon={<MapPinned size={13} />}
              />
            </div>
            <div className="ground-state">
              <span>ON-GROUND STATUS</span>
              <strong
                className={
                  latest?.onGround == null
                    ? "unavailable"
                    : latest.onGround
                      ? "ground"
                      : "airborne"
                }
              >
                {latest?.onGround == null
                  ? "UNAVAILABLE"
                  : latest.onGround
                    ? "ON GROUND"
                    : "AIRBORNE"}
              </strong>
            </div>
            <div className="telemetry-foot">
              <span>
                <Clock3 size={12} />{" "}
                {latest
                  ? `${new Date(latest.timestamp).toISOString().slice(11, 19)} UTC`
                  : "NO SAMPLE"}
              </span>
              <span>
                {latest?.quality === "calculated"
                  ? "CALCULATED"
                  : latest
                    ? "OBSERVED"
                    : "NO DATA"}
              </span>
            </div>
          </section>
        </div>

        <FlightCharts
          samples={samples}
          sessionStartedAt={status.session?.startedAt ?? null}
          totalSampleCount={totalSampleCount}
        />
        <EventTimeline session={status.session} samples={samples} />

        <footer className="app-footer">
          <span>
            {IS_PUBLIC_DEMO_MODE
              ? "AEROTRACE · SAMPLE FLIGHT RECORDER"
              : "AEROTRACE · LOCAL FLIGHT RECORDER"}
          </span>
          <span>
            {IS_PUBLIC_DEMO_MODE
              ? "SAMPLE DATA · LOCAL CONNECTOR NOT USED"
              : connectorOnline
                ? "127.0.0.1 · CONNECTOR READY"
                : "LOCAL CONNECTOR OFFLINE"}
          </span>
        </footer>
      </div>
    </main>
  );
}

function Instrument({
  label,
  value,
  unit,
  icon,
}: {
  label: string;
  value: string;
  unit: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="instrument-cell">
      <div className="instrument-label">
        <span>{icon}</span>
        {label}
      </div>
      <div className="instrument-value">
        {value}
        <span>{unit}</span>
      </div>
    </div>
  );
}
