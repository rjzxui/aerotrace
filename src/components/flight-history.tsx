"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Clock3,
  Plane,
  RefreshCw,
} from "lucide-react";
import AeroTraceHeader from "@/components/aerotrace-header";
import { fetchFlightList, fetchFlightReport } from "@/lib/flight-api";
import type { FlightReport, FlightSession } from "@/lib/contracts";

type HistoryData = {
  sessions: FlightSession[];
  reports: Record<string, FlightReport>;
  reportErrors: Record<string, string>;
};

function formatUtc(value: string | null) {
  if (!value) return "Unavailable";
  return `${new Date(value).toLocaleString("en-GB", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })} UTC`;
}

function formatDuration(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return "Unavailable";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function routeDistance(report: FlightReport | undefined) {
  if (!report || report.summary.routeDistanceStatus === "no_valid_segments")
    return "Unavailable";
  return `${(report.summary.routeDistanceM / 1852).toLocaleString("en-US", { maximumFractionDigits: 1 })} NM`;
}

function duration(session: FlightSession, report: FlightReport | undefined) {
  if (report) return formatDuration(report.summary.recordingDurationSeconds);
  if (session.startedAt && session.completedAt) {
    return formatDuration(
      (Date.parse(session.completedAt) - Date.parse(session.startedAt)) / 1000,
    );
  }
  return "Unavailable";
}

function sourceText(session: FlightSession) {
  return session.source === "demo" ? "DEMO · SYNTHETIC" : "MSFS · SIMCONNECT";
}

async function loadHistoryData(): Promise<HistoryData> {
  const sessions = await fetchFlightList();
  const reports: Record<string, FlightReport> = {};
  const reportErrors: Record<string, string> = {};
  let nextSessionIndex = 0;
  const worker = async () => {
    while (nextSessionIndex < sessions.length) {
      const session = sessions[nextSessionIndex++];
      try {
        reports[session.sessionId] = await fetchFlightReport(session.sessionId);
      } catch (cause) {
        reportErrors[session.sessionId] =
          cause instanceof Error ? cause.message : "Summary unavailable";
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(5, sessions.length) }, worker),
  );
  return { sessions, reports, reportErrors };
}

export default function FlightHistory() {
  const [data, setData] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await loadHistoryData());
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load flight history.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void loadHistoryData()
      .then((result) => {
        if (active) setData(result);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load flight history.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="dashboard-shell">
      <AeroTraceHeader />
      <div className="history-shell">
        <div className="history-heading">
          <div>
            <span className="eyebrow">LOCAL ARCHIVE · SQLITE</span>
            <h1>Flight history</h1>
            <p>Persisted AeroTrace sessions from this computer.</p>
          </div>
          <Link href="/" className="text-link">
            OPEN RECORDER <ArrowUpRight size={14} />
          </Link>
        </div>
        {loading && (
          <section className="history-state" role="status">
            <RefreshCw size={18} className="spin-icon" />
            <strong>READING FLIGHT ARCHIVE</strong>
            <span>Loading saved sessions and available summaries.</span>
          </section>
        )}
        {error && !loading && (
          <section className="history-error" role="alert">
            <AlertTriangle size={18} />
            <div>
              <strong>FLIGHT HISTORY UNAVAILABLE</strong>
              <span>{error}</span>
            </div>
            <button type="button" onClick={() => void reload()}>
              <RefreshCw size={14} /> RETRY
            </button>
          </section>
        )}
        {data && !loading && !error && data.sessions.length === 0 && (
          <section className="history-empty" role="status">
            <Plane size={22} />
            <strong>NO SAVED FLIGHTS</strong>
            <span>Completed or interrupted recordings will appear here.</span>
            <Link href="/" className="text-link">
              GO TO RECORDER <ArrowUpRight size={14} />
            </Link>
          </section>
        )}
        {data && !loading && !error && data.sessions.length > 0 && (
          <>
            <div className="history-table-top">
              <span>
                {data.sessions.length.toLocaleString()} SAVED SESSION
                {data.sessions.length === 1 ? "" : "S"}
              </span>
              <span>LOCAL DATABASE · NEWEST FIRST</span>
            </div>
            <div className="history-list">
              {data.sessions.map((session) => {
                const report = data.reports[session.sessionId];
                const status = report?.recordingStatus ?? session.state;
                const failed = data.reportErrors[session.sessionId];
                return (
                  <Link
                    href={`/flights/${session.sessionId}`}
                    className="history-row"
                    key={session.sessionId}
                  >
                    <div className="history-row-main">
                      <span
                        className={`history-status-dot status-dot-${status}`}
                      />
                      <div>
                        <span className="history-id">
                          {session.sessionId.toUpperCase()}
                        </span>
                        <strong>{formatUtc(session.startedAt)}</strong>
                      </div>
                    </div>
                    <div className="history-field">
                      <span>SOURCE</span>
                      <strong>{sourceText(session)}</strong>
                    </div>
                    <div className="history-field">
                      <span>STATUS</span>
                      <strong className={`history-status status-${status}`}>
                        {status.replaceAll("_", " ").toUpperCase()}
                      </strong>
                    </div>
                    <div className="history-field">
                      <span>DURATION</span>
                      <strong>{duration(session, report)}</strong>
                    </div>
                    <div className="history-field">
                      <span>RECORDED ROUTE</span>
                      <strong>{routeDistance(report)}</strong>
                    </div>
                    <div className="history-row-tail">
                      {failed && (
                        <small>
                          <Clock3 size={12} /> SUMMARY UNAVAILABLE
                        </small>
                      )}
                      <ArrowUpRight size={16} />
                    </div>
                  </Link>
                );
              })}
            </div>
            <p className="history-footnote">
              A missing summary does not remove the saved session. Open the
              record to retry its report and telemetry.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
