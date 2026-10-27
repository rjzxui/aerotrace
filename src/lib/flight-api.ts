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

export const FLIGHT_TELEMETRY_PAGE_SIZE = 10_000;
export const LIVE_TELEMETRY_WINDOW_SIZE = 5_000;
const DEFAULT_LOCAL_API = "http://127.0.0.1:8765";

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

const apiConfiguration = resolveLocalApiUrl(
  process.env.NEXT_PUBLIC_AEROTRACE_API_URL,
);
export const FLIGHT_API_BASE = apiConfiguration.baseUrl;
export const FLIGHT_API_CONFIGURATION_ERROR = apiConfiguration.error;

export type FlightReportBundle = {
  report: FlightReport;
  analysis: FlightAnalysis;
  telemetry: TelemetrySample[];
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
): Promise<FlightSession[]> {
  const payload = await responseJson(
    await fetcher(`${FLIGHT_API_BASE}/api/flights`, { cache: "no-store" }),
    "Could not load flight history",
  );
  return FlightSessionSchema.array().parse(payload);
}

export async function fetchFlightReport(
  sessionId: string,
  fetcher: typeof fetch = fetch,
): Promise<FlightReport> {
  const payload = await responseJson(
    await fetcher(`${FLIGHT_API_BASE}/api/flights/${sessionId}`, {
      cache: "no-store",
    }),
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
): Promise<FlightAnalysis> {
  const payload = await responseJson(
    await fetcher(`${FLIGHT_API_BASE}/api/flights/${sessionId}/analysis`, {
      cache: "no-store",
    }),
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
): Promise<TelemetrySample[]> {
  const allSamples: TelemetrySample[] = [];
  for (let offset = 0; ; offset += FLIGHT_TELEMETRY_PAGE_SIZE) {
    const payload = await responseJson(
      await fetcher(
        `${FLIGHT_API_BASE}/api/flights/${sessionId}/telemetry?offset=${offset}&limit=${FLIGHT_TELEMETRY_PAGE_SIZE}`,
        { cache: "no-store", signal },
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
): Promise<TelemetrySample[]> {
  const offset = Math.max(
    0,
    Math.floor(totalSamples) - LIVE_TELEMETRY_WINDOW_SIZE,
  );
  const payload = await responseJson(
    await fetcher(
      `${FLIGHT_API_BASE}/api/flights/${sessionId}/telemetry?offset=${offset}&limit=${LIVE_TELEMETRY_WINDOW_SIZE}`,
      { cache: "no-store", signal },
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
): Promise<FlightReportBundle> {
  const [report, analysis] = await Promise.all([
    fetchFlightReport(sessionId, fetcher),
    fetchFlightAnalysis(sessionId, fetcher),
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
  );
  return { report, analysis, telemetry };
}

export async function finalizeFlight(
  sessionId: string,
  fetcher: typeof fetch = fetch,
): Promise<ConnectorStatus> {
  const payload = await responseJson(
    await fetcher(`${FLIGHT_API_BASE}/api/flights/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }),
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
