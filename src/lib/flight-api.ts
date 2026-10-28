import {
  ConnectorStatusSchema,
  FlightAnalysisSchema,
  FlightReportSchema,
  FlightSessionSchema,
  TelemetrySampleSchema,
} from "./contracts.ts";
import type {
  ConnectorStatus,
  FlightAnalysis,
  FlightReport,
  FlightSession,
  TelemetrySample,
} from "./contracts.ts";
import { DEMO_FLIGHT_SESSIONS, getDemoFlightBundle } from "./demo-data.ts";
import {
  getDemoArchiveEntry,
  listDemoArchiveSessions,
  saveDemoArchiveEntry,
} from "./demo-archive.ts";

export const FLIGHT_TELEMETRY_PAGE_SIZE = 10_000;
export const LIVE_TELEMETRY_WINDOW_SIZE = 5_000;
const DEFAULT_LOCAL_API = "http://127.0.0.1:8765";

export function parsePublicDemoMode(value?: string) {
  return value?.trim().toLowerCase() === "true";
}

export const IS_PUBLIC_DEMO_MODE = parsePublicDemoMode(
  process.env.NEXT_PUBLIC_DEMO_MODE,
);

export function resolveLocalApiUrl(value?: string): {
  baseUrl: string;
  error: string | null;
} {
  const candidate = value?.trim();
  if (!candidate) return { baseUrl: DEFAULT_LOCAL_API, error: null };
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "::1"].includes(hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("unsupported URL");
    }
    return {
      baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`,
      error: null,
    };
  } catch {
    return {
      baseUrl: DEFAULT_LOCAL_API,
      error:
        "The connector URL must use local HTTP at localhost, 127.0.0.1 or [::1]. Public API hosts are blocked.",
    };
  }
}

export function resolveFlightApiConfiguration(
  value: string | undefined,
  demoMode: boolean,
) {
  return demoMode ? { baseUrl: "", error: null } : resolveLocalApiUrl(value);
}

const apiConfiguration = resolveFlightApiConfiguration(
  process.env.NEXT_PUBLIC_AEROTRACE_API_URL,
  IS_PUBLIC_DEMO_MODE,
);
export const FLIGHT_API_BASE = apiConfiguration.baseUrl;
export const FLIGHT_API_CONFIGURATION_ERROR = apiConfiguration.error;

export async function requestLocalConnector(
  path: string,
  init?: RequestInit,
  fetcher: typeof fetch = fetch,
  demoMode = IS_PUBLIC_DEMO_MODE,
): Promise<Response> {
  if (demoMode || IS_PUBLIC_DEMO_MODE) {
    throw new Error("Local connector access is disabled in public demo mode.");
  }
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Connector requests must use a local API path.");
  }
  return fetcher(`${FLIGHT_API_BASE}${path}`, init);
}

export type FlightReportBundle = {
  report: FlightReport;
  analysis: FlightAnalysis;
  telemetry: TelemetrySample[];
  archive?: {
    storage: "browser" | "browser+sqlite";
    syncWarning?: string;
  };
};

export function claimFlightAction(lock: { current: boolean }) {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

async function responseJson(
  response: Response,
  fallback: string,
): Promise<unknown> {
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok) return payload;
  if (
    typeof payload === "object" &&
    payload !== null &&
    "detail" in payload &&
    typeof payload.detail === "string"
  ) {
    throw new Error(payload.detail);
  }
  throw new Error(`${fallback} · ${response.status}`);
}

export async function fetchFlightList(
  fetcher: typeof fetch = fetch,
  demoMode = IS_PUBLIC_DEMO_MODE,
): Promise<FlightSession[]> {
  if (demoMode) return [...DEMO_FLIGHT_SESSIONS];
  const localSessions = await listDemoArchiveSessions();
  try {
    const payload = await responseJson(
      await requestLocalConnector(
        "/api/flights",
        { cache: "no-store" },
        fetcher,
        demoMode,
      ),
      "Could not load flight history",
    );
    const connectorSessions = FlightSessionSchema.array().parse(payload);
    const sessions = new Map(
      [...connectorSessions, ...localSessions].map((session) => [
        session.sessionId,
        session,
      ]),
    );
    return [...sessions.values()].sort(
      (left, right) =>
        Date.parse(right.startedAt ?? "") - Date.parse(left.startedAt ?? ""),
    );
  } catch (error) {
    if (localSessions.length > 0) return localSessions;
    throw error;
  }
}

export async function fetchFlightReport(
  sessionId: string,
  fetcher: typeof fetch = fetch,
  demoMode = IS_PUBLIC_DEMO_MODE,
): Promise<FlightReport> {
  if (demoMode) return getDemoFlightBundle(sessionId).report;
  const localEntry = await getDemoArchiveEntry(sessionId);
  if (localEntry?.bundle) return localEntry.bundle.report;
  const payload = await responseJson(
    await requestLocalConnector(
      `/api/flights/${sessionId}`,
      { cache: "no-store" },
      fetcher,
      demoMode,
    ),
    "Could not load this flight report",
  );
  const report = FlightReportSchema.parse(payload);
  if (report.session.sessionId !== sessionId) {
    throw new Error("The connector returned a report for a different flight.");
  }
  return report;
}

export async function fetchFlightAnalysis(
  sessionId: string,
  fetcher: typeof fetch = fetch,
  demoMode = IS_PUBLIC_DEMO_MODE,
): Promise<FlightAnalysis> {
  if (demoMode) return getDemoFlightBundle(sessionId).analysis;
  const localEntry = await getDemoArchiveEntry(sessionId);
  if (localEntry?.bundle) return localEntry.bundle.analysis;
  const payload = await responseJson(
    await requestLocalConnector(
      `/api/flights/${sessionId}/analysis`,
      { cache: "no-store" },
      fetcher,
      demoMode,
    ),
    "Could not load flight analysis",
  );
  const analysis = FlightAnalysisSchema.parse(payload);
  if (analysis.sessionId !== sessionId) {
    throw new Error("The connector returned analysis for a different flight.");
  }
  return analysis;
}

export async function fetchFlightTelemetry(
  sessionId: string,
  source: FlightSession["source"],
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  demoMode = IS_PUBLIC_DEMO_MODE,
): Promise<TelemetrySample[]> {
  if (demoMode) {
    const bundle = getDemoFlightBundle(sessionId);
    if (bundle.report.session.source !== source) {
      throw new Error("Telemetry did not match the selected flight session.");
    }
    return bundle.telemetry;
  }
  const localEntry = await getDemoArchiveEntry(sessionId);
  if (localEntry) {
    if (localEntry.session.source !== source) {
      throw new Error("Telemetry did not match the selected flight session.");
    }
    return localEntry.telemetry;
  }
  const allSamples: TelemetrySample[] = [];
  for (let offset = 0; ; offset += FLIGHT_TELEMETRY_PAGE_SIZE) {
    const payload = await responseJson(
      await requestLocalConnector(
        `/api/flights/${sessionId}/telemetry?offset=${offset}&limit=${FLIGHT_TELEMETRY_PAGE_SIZE}`,
        { cache: "no-store", signal },
        fetcher,
        demoMode,
      ),
      "Could not load recorded telemetry",
    );
    const page = TelemetrySampleSchema.array().parse(payload);
    for (const sample of page) {
      if (sample.sessionId !== sessionId || sample.source !== source) {
        throw new Error("Telemetry did not match the selected flight session.");
      }
    }
    allSamples.push(...page);
    if (page.length < FLIGHT_TELEMETRY_PAGE_SIZE) break;
  }
  return allSamples;
}

export async function fetchFlightTelemetryWindow(
  sessionId: string,
  source: FlightSession["source"],
  totalSamples: number,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  demoMode = IS_PUBLIC_DEMO_MODE,
): Promise<TelemetrySample[]> {
  if (demoMode) {
    const bundle = getDemoFlightBundle(sessionId);
    if (bundle.report.session.source !== source) {
      throw new Error("Telemetry did not match the selected flight session.");
    }
    const samples = bundle.telemetry;
    return samples.slice(
      Math.max(0, Math.floor(totalSamples) - LIVE_TELEMETRY_WINDOW_SIZE),
      Math.floor(totalSamples),
    );
  }
  const localEntry = await getDemoArchiveEntry(sessionId);
  if (localEntry) {
    if (localEntry.session.source !== source) {
      throw new Error("Telemetry did not match the selected flight session.");
    }
    return localEntry.telemetry.slice(
      Math.max(0, Math.floor(totalSamples) - LIVE_TELEMETRY_WINDOW_SIZE),
      Math.floor(totalSamples),
    );
  }
  const offset = Math.max(
    0,
    Math.floor(totalSamples) - LIVE_TELEMETRY_WINDOW_SIZE,
  );
  const payload = await responseJson(
    await requestLocalConnector(
      `/api/flights/${sessionId}/telemetry?offset=${offset}&limit=${LIVE_TELEMETRY_WINDOW_SIZE}`,
      { cache: "no-store", signal },
      fetcher,
      demoMode,
    ),
    "Could not load recent recorded telemetry",
  );
  const samples = TelemetrySampleSchema.array().parse(payload);
  for (const sample of samples) {
    if (sample.sessionId !== sessionId || sample.source !== source) {
      throw new Error("Telemetry did not match the selected flight session.");
    }
  }
  return samples;
}

export async function loadFlightReportBundle(
  sessionId: string,
  fetcher: typeof fetch = fetch,
  demoMode = IS_PUBLIC_DEMO_MODE,
): Promise<FlightReportBundle> {
  if (demoMode) return getDemoFlightBundle(sessionId);
  const localEntry = await getDemoArchiveEntry(sessionId);
  if (localEntry?.bundle) return localEntry.bundle;
  const [report, analysis] = await Promise.all([
    fetchFlightReport(sessionId, fetcher, demoMode),
    fetchFlightAnalysis(sessionId, fetcher, demoMode),
  ]);
  if (report.session.sessionId !== analysis.sessionId) {
    throw new Error("The report and analysis refer to different flights.");
  }
  if (report.recordingStatus !== analysis.recordingStatus) {
    throw new Error(
      "The report and analysis have different recording statuses.",
    );
  }
  const telemetry = await fetchFlightTelemetry(
    sessionId,
    report.session.source,
    fetcher,
    undefined,
    demoMode,
  );
  return { report, analysis, telemetry };
}

export async function finalizeFlight(
  sessionId: string,
  fetcher: typeof fetch = fetch,
  demoMode = IS_PUBLIC_DEMO_MODE,
): Promise<ConnectorStatus> {
  if (demoMode) {
    throw new Error("Recording controls are disabled in public demo mode.");
  }
  const payload = await responseJson(
    await requestLocalConnector(
      "/api/flights/complete",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      },
      fetcher,
      demoMode,
    ),
    "Could not complete flight",
  );
  const status = ConnectorStatusSchema.parse(payload);
  if (
    status.state !== "completed" ||
    status.session?.state !== "completed" ||
    status.session.sessionId !== sessionId ||
    !status.session.completedAt
  ) {
    throw new Error("The connector did not confirm flight completion.");
  }
  return status;
}

export async function archiveDemoFlightToConnector(
  bundle: FlightReportBundle,
  fetcher: typeof fetch = fetch,
): Promise<FlightReport> {
  if (
    bundle.report.session.source !== "demo" ||
    bundle.report.recordingStatus !== "complete" ||
    bundle.report.session.state !== "completed" ||
    bundle.report.session.completedAt == null
  ) {
    throw new Error("Only a completed synthetic demo can be copied to SQLite.");
  }
  const payload = await responseJson(
    await requestLocalConnector(
      "/api/flights/import-demo",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session: bundle.report.session,
          samples: bundle.telemetry,
        }),
      },
      fetcher,
    ),
    "Could not copy the demo flight to SQLite",
  );
  const report = FlightReportSchema.parse(payload);
  if (
    report.session.sessionId !== bundle.report.session.sessionId ||
    report.session.source !== "demo" ||
    report.recordingStatus !== "complete"
  ) {
    throw new Error("The connector returned a different demo flight record.");
  }
  return report;
}

export async function retryDemoFlightSqliteArchive(
  sessionId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const entry = await getDemoArchiveEntry(sessionId);
  if (!entry?.bundle) {
    throw new Error(
      "The completed demo is not available in the browser archive.",
    );
  }
  await archiveDemoFlightToConnector(entry.bundle, fetcher);
  await saveDemoArchiveEntry({
    ...entry,
    bundle: {
      ...entry.bundle,
      archive: { storage: "browser+sqlite" },
    },
  });
}
