"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TelemetrySample } from "@/lib/contracts";
import { formatElapsedMinutes } from "@/lib/flight-report-model";

type ChartPoint = {
  elapsedMinutes: number;
  timestamp: string;
  altitudeFt: number | null;
  airspeedKt: number | null;
  groundSpeedKt: number | null;
  verticalSpeedFpm: number | null;
};

const toKnots = (value: number | null) =>
  value == null ? null : value * 1.94384;
const toFeet = (value: number | null) =>
  value == null ? null : value * 3.28084;

function chartPoints(samples: TelemetrySample[]): ChartPoint[] {
  if (samples.length === 0) return [];
  const start = Date.parse(samples[0].timestamp);
  const step = Math.max(1, Math.ceil(samples.length / 900));
  const indices = new Set<number>([0, samples.length - 1]);
  for (let index = 0; index < samples.length; index += step) indices.add(index);
  return [...indices]
    .sort((left, right) => left - right)
    .map((index) => {
      const sample = samples[index];
      return {
        elapsedMinutes: (Date.parse(sample.timestamp) - start) / 60_000,
        timestamp: sample.timestamp,
        altitudeFt: toFeet(sample.altitudeM),
        airspeedKt: toKnots(sample.airspeedMps),
        groundSpeedKt: toKnots(sample.groundSpeedMps),
        verticalSpeedFpm:
          sample.verticalSpeedMps == null
            ? null
            : sample.verticalSpeedMps * 196.8504,
      };
    });
}

function formatValue(value: number | null | undefined) {
  return value == null ? "—" : Math.round(value).toLocaleString();
}

function MetricChart({
  title,
  unit,
  data,
  series,
  emptyLabel,
}: {
  title: string;
  unit: string;
  data: ChartPoint[];
  series: { key: keyof ChartPoint; name: string; color: string }[];
  emptyLabel: string;
}) {
  const hasValues = data.some((point) =>
    series.some((line) => point[line.key] != null),
  );
  const lastValue = data.at(-1)?.[series[0].key];

  return (
    <article className="chart-panel">
      <div className="chart-heading">
        <div>
          <h3>{title}</h3>
          <span>{unit}</span>
        </div>
        <strong>
          {formatValue(typeof lastValue === "number" ? lastValue : null)}
        </strong>
      </div>
      <div className="chart-area">
        {hasValues ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 8, right: 9, bottom: 2, left: -14 }}
            >
              <CartesianGrid
                stroke="#29343d"
                strokeDasharray="2 5"
                vertical={false}
              />
              <XAxis
                dataKey="elapsedMinutes"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={formatElapsedMinutes}
                tick={{ fill: "#788591", fontSize: 9 }}
                axisLine={{ stroke: "#39434c" }}
                tickLine={false}
                minTickGap={26}
              />
              <YAxis
                width={47}
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
                labelFormatter={(value) =>
                  `ELAPSED ${formatElapsedMinutes(Number(value))}`
                }
                formatter={(value, name) => [
                  `${formatValue(typeof value === "number" ? value : null)} ${unit}`,
                  name,
                ]}
              />
              {series.map((line) => (
                <Line
                  key={line.key}
                  type="monotone"
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
            {emptyLabel}
          </div>
        )}
      </div>
    </article>
  );
}

export default function FlightCharts({
  samples,
  sessionStartedAt,
  totalSampleCount,
}: {
  samples: TelemetrySample[];
  sessionStartedAt: string | null;
  totalSampleCount: number;
}) {
  const points = chartPoints(samples);
  const emptyLabel = sessionStartedAt
    ? "Waiting for supported measurements"
    : "Start a flight to collect chart data";
  return (
    <section className="charts-section" aria-labelledby="charts-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">FLIGHT PROFILE</span>
          <h2 id="charts-title">Recorded telemetry</h2>
        </div>
        <span className="chart-sample-count">
          {samples.length < totalSampleCount
            ? `${samples.length.toLocaleString()} OF ${totalSampleCount.toLocaleString()} · LIVE WINDOW`
            : `${totalSampleCount.toLocaleString()} SAMPLES`}
        </span>
      </div>
      <div className="charts-grid">
        <MetricChart
          title="ALTITUDE"
          unit="FT"
          data={points}
          series={[{ key: "altitudeFt", name: "Altitude", color: "#e0bd7e" }]}
          emptyLabel={emptyLabel}
        />
        <MetricChart
          title="SPEED"
          unit="KT"
          data={points}
          series={[
            { key: "airspeedKt", name: "Airspeed", color: "#73b8c1" },
            { key: "groundSpeedKt", name: "Ground speed", color: "#8f98d0" },
          ]}
          emptyLabel={emptyLabel}
        />
        <MetricChart
          title="VERTICAL SPEED"
          unit="FT / MIN"
          data={points}
          series={[
            {
              key: "verticalSpeedFpm",
              name: "Vertical speed",
              color: "#c68f75",
            },
          ]}
          emptyLabel={emptyLabel}
        />
      </div>
    </section>
  );
}
