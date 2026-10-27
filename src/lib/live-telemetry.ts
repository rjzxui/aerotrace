import type { TelemetrySample } from "./contracts.ts";

export const MAX_LIVE_TELEMETRY_SAMPLES = 5_000;

/** Merge reconnect backfill and live observations into a bounded, ordered view. */
export function mergeLiveSamples(
  current: TelemetrySample[],
  incoming: TelemetrySample[],
  maxSamples = MAX_LIVE_TELEMETRY_SAMPLES,
): TelemetrySample[] {
  if (maxSamples < 1) return [];
  if (incoming.length === 0) return current.slice(-maxSamples);
  if (incoming.length === 1) {
    const sample = incoming[0];
    const last = current.at(-1);
    if (current.some((item) => item.sampleId === sample.sampleId))
      return current;
    if (!last || Date.parse(last.timestamp) <= Date.parse(sample.timestamp)) {
      return [...current, sample].slice(-maxSamples);
    }
  }

  const byId = new Map(current.map((sample) => [sample.sampleId, sample]));
  for (const sample of incoming) byId.set(sample.sampleId, sample);
  return [...byId.values()]
    .sort(
      (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
    )
    .slice(-maxSamples);
}
