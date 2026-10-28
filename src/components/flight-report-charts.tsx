"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TelemetrySample } from "@/lib/contracts";
import { buildFlightChartPoints } from "@/lib/flight-report-model";

function utcClock(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatValue(value: number | null | undefined) {
  return value == null || !Number.isFinite(value)
    ? "—"
    : Math.round(value).toLocaleString();
}

function MetricSeries({
  title,
  unit,
  data,
  selectedTime,
  lines,
}: {
  title: string;
  unit: string;
  data: ReturnType<typeof buildFlightChartPoints>;
  selectedTime: number | null;
  lines: {
    key: "altitudeFt" | "airspeedKt" | "groundSpeedKt" | "verticalSpeedFpm";
    name: string;
    color: string;
  }[];
}) {
  const hasValues = data.some((point) =>
    lines.some((line) => point[line.key] != null),
  );
  return (
    <article className="chart-panel report-chart-panel">
      <div className="chart-heading">
        <div>
          <h3>{title}</h3>
          <span>{unit} · UTC</span>
        </div>
      </div>
      <div className="chart-area report-chart-area">
        {hasValues ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              syncId="flight-replay"
              margin={{ top: 8, right: 13, bottom: 2, left: -12 }}
            >
              <CartesianGrid
                stroke="#29343d"
                strokeDasharray="2 5"
                vertical={false}
              />
              <XAxis
                dataKey="timeMs"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(value) => utcClock(Number(value))}
                tick={{ fill: "#788591", fontSize: 9 }}
                axisLine={{ stroke: "#39434c" }}
                tickLine={false}
                minTickGap={28}
              />
              <YAxis
                width={48}
                tickFormatter={formatValue}
                tick={{ fill: "#788591", fontSize: 9 }}
                axisLine={false}
                tickLine={false}
                domain={["auto", "auto"]}
              />
              <Tooltip
                contentStyle={{
                  background: "#111820",
                  border: "1px solid #35414b",
                  borderRadius: 2,
                  color: "#dce3e8",
                  fontSize: 11,
                }}
                labelFormatter={(value) => `${utcClock(Number(value))} UTC`}
                formatter={(value, name) => [
                  `${formatValue(typeof value === "number" ? value : null)} ${unit}`,
                  name,
                ]}
              />
              {selectedTime != null && (
                <ReferenceLine
                  x={selectedTime}
                  stroke="#e0bd7e"
                  strokeDasharray="3 3"
                  strokeWidth={1.5}
                />
              )}
              {lines.map((line) => (
                <Line
                  key={line.key}
                  type="linear"
                  dataKey={line.key}
                  name={line.name}
                  stroke={line.color}
                  strokeWidth={1.7}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="chart-empty" role="status">
            No recorded {title.toLowerCase()} measurements.
          </div>
        )}
      </div>
      <div className="report-chart-legend" aria-label={`${title} series`}>
        {lines.map((line) => {
          const available = data.some((point) => point[line.key] != null);
          return (
            <span
              key={line.key}
              className={available ? "" : "legend-unavailable"}
            >
              <i style={{ backgroundColor: line.color }} />
              {line.name}
              {available ? "" : " · UNAVAILABLE"}
            </span>
          );
        })}
      </div>
    </article>
  );
}

export default function FlightReportCharts({
  samples,
  selectedSample,
}: {
  samples: TelemetrySample[];
  selectedSample: TelemetrySample | null;
}) {
  const data = useMemo(() => buildFlightChartPoints(samples), [samples]);
  const selectedTime = selectedSample
    ? Date.parse(selectedSample.timestamp)
    : null;
  return (
    <section className="report-section" aria-labelledby="report-charts-title">
      <div className="report-section-heading">
        <div>
          <span className="eyebrow">RECORDED PROFILE</span>
          <h2 id="report-charts-title">Telemetry traces</h2>
        </div>
        <span className="chart-sample-count">
          UTC TIMESTAMPS · NULLS PRESERVED
        </span>
      </div>
      <div className="report-charts-grid">
        <MetricSeries
          title="ALTITUDE"
          unit="FT MSL"
          data={data}
          selectedTime={selectedTime}
          lines={[{ key: "altitudeFt", name: "Altitude", color: "#e0bd7e" }]}
        />
        <MetricSeries
          title="AIRSPEED / GROUND SPEED"
          unit="KT"
          data={data}
          selectedTime={selectedTime}
          lines={[
            { key: "airspeedKt", name: "Airspeed", color: "#73b8c1" },
            { key: "groundSpeedKt", name: "Ground speed", color: "#8f98d0" },
          ]}
        />
        <MetricSeries
          title="VERTICAL SPEED"
          unit="FT / MIN"
          data={data}
          selectedTime={selectedTime}
          lines={[
            {
              key: "verticalSpeedFpm",
              name: "Vertical speed",
              color: "#c68f75",
            },
          ]}
        />
      </div>
      <p className="report-chart-note">
        All traces share UTC observation times. Gaps remain visible where a
        measurement was unavailable; dense recordings are evenly thinned for
        display.
      </p>
    </section>
  );
}
