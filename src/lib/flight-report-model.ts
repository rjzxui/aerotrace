import type { TelemetrySample } from "./contracts.ts";

export type FlightChartPoint = {
  timeMs: number;
  altitudeFt: number | null;
  airspeedKt: number | null;
  groundSpeedKt: number | null;
  verticalSpeedFpm: number | null;
};

const toFeet = (value: number | null) =>
  value == null ? null : value * 3.28084;
const toKnots = (value: number | null) =>
  value == null ? null : value * 1.94384;
const toFpm = (value: number | null) =>
  value == null ? null : value * 196.8504;

export function formatElapsedMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return "—";
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = Math.floor(minutes % 60);
  return hours > 0
    ? `${hours}h${String(remainingMinutes).padStart(2, "0")}`
    : `${Math.floor(minutes)}m`;
}

/** Evenly thin dense recordings while retaining the first and final observation. */
export function buildFlightChartPoints(
  samples: TelemetrySample[],
  maxPoints = 1200,
): FlightChartPoint[] {
  if (samples.length === 0) return [];
  const stride = Math.max(1, Math.ceil(samples.length / maxPoints));
  const indices = new Set<number>();
  for (let index = 0; index < samples.length; index += stride)
    indices.add(index);
  indices.add(samples.length - 1);
  return [...indices].map((index) => {
    const sample = samples[index];
    return {
      timeMs: Date.parse(sample.timestamp),
      altitudeFt: toFeet(sample.altitudeM),
      airspeedKt: toKnots(sample.airspeedMps),
      groundSpeedKt: toKnots(sample.groundSpeedMps),
      verticalSpeedFpm: toFpm(sample.verticalSpeedMps),
    };
  });
}
