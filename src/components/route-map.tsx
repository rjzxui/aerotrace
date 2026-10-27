"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LngLatBounds,
  Map as MapLibre,
  Marker,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
  type Map as MapInstance,
} from "maplibre-gl";
import type { Feature, MultiLineString } from "geojson";
import { Crosshair, MapPin, Route, WifiOff } from "lucide-react";
import type { FlightLifecycleState, TelemetrySample } from "@/lib/contracts";

const STYLE_URL = "https://demotiles.maplibre.org/style.json";
const MAX_ROUTE_GAP_MS = 30_000;
const EMPTY_LINE: Feature<MultiLineString> = {
  type: "Feature",
  properties: {},
  geometry: { type: "MultiLineString", coordinates: [] },
};

type RouteMapProps = {
  samples: TelemetrySample[];
  sessionId: string | null;
  state: FlightLifecycleState;
  connectorOnline: boolean;
};

function routePoints(samples: TelemetrySample[]) {
  return samples.flatMap((sample) =>
    sample.latitudeDeg != null && sample.longitudeDeg != null
      ? [[sample.longitudeDeg, sample.latitudeDeg] as [number, number]]
      : [],
  );
}

function routeSegments(samples: TelemetrySample[]) {
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  let previousTimestamp: number | null = null;
  for (const sample of samples) {
    const hasPosition =
      sample.latitudeDeg != null && sample.longitudeDeg != null;
    const timestamp = Date.parse(sample.timestamp);
    if (
      previousTimestamp != null &&
      timestamp - previousTimestamp > MAX_ROUTE_GAP_MS
    ) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    if (!hasPosition) continue;
    current.push([sample.longitudeDeg as number, sample.latitudeDeg as number]);
    previousTimestamp = timestamp;
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

export default function RouteMap({
  samples,
  sessionId,
  state,
  connectorOnline,
}: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const fittedSessionRef = useRef<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // MapLibre v6 is ESM-only; Next.js/Turbopack emits this worker as a same-origin asset.
    setWorkerUrl(
      new URL(
        "maplibre-gl/dist/maplibre-gl-worker.mjs",
        import.meta.url,
      ).toString(),
    );
    const map = new MapLibre({
      container: containerRef.current,
      style: STYLE_URL,
      center: [0, 15],
      zoom: 1.6,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: true }), "top-right");

    map.once("load", () => {
      map.addSource("aerotrace-route", {
        type: "geojson",
        data: EMPTY_LINE,
      });
      map.addLayer({
        id: "aerotrace-route-line",
        type: "line",
        source: "aerotrace-route",
        paint: {
          "line-color": "#e0bd7e",
          "line-width": 3,
          "line-opacity": 0.92,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      setMapReady(true);
      setMapError(null);
      requestAnimationFrame(() => map.resize());
    });
    map.on("error", () => {
      if (!map.isStyleLoaded()) {
        setMapError(
          "Map style or tiles could not be reached. Check your connection.",
        );
      }
    });

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);
    return () => {
      resizeObserver.disconnect();
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const points = useMemo(() => routePoints(samples), [samples]);
  const segments = useMemo(() => routeSegments(samples), [samples]);
  const fitTrack = useCallback(() => {
    const map = mapRef.current;
    if (!map || points.length < 2) return;
    const bounds = points.reduce(
      (value, coordinate) => value.extend(coordinate),
      new LngLatBounds(points[0], points[0]),
    );
    map.fitBounds(bounds, { padding: 72, maxZoom: 9, duration: 750 });
  }, [points]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const route = map.getSource("aerotrace-route") as GeoJSONSource | undefined;
    if (route) {
      const feature: Feature<MultiLineString> = {
        type: "Feature",
        properties: {},
        geometry: { type: "MultiLineString", coordinates: segments },
      };
      route.setData(feature);
    }

    const latest = [...samples]
      .reverse()
      .find((item) => item.latitudeDeg != null && item.longitudeDeg != null);
    if (latest?.latitudeDeg != null && latest.longitudeDeg != null) {
      if (!markerRef.current) {
        const element = document.createElement("div");
        element.className = "aerotrace-aircraft-marker";
        element.setAttribute("role", "img");
        element.setAttribute("aria-label", "Current aircraft position");
        element.textContent = "▲";
        markerRef.current = new Marker({
          element,
          anchor: "center",
          rotationAlignment: "map",
        })
          .setLngLat([latest.longitudeDeg, latest.latitudeDeg])
          .addTo(map);
      }
      markerRef.current.setLngLat([latest.longitudeDeg, latest.latitudeDeg]);
      markerRef.current.setRotation(latest.headingDeg ?? 0);
      markerRef.current
        .getElement()
        .setAttribute(
          "aria-label",
          `Aircraft position, heading ${latest.headingDeg == null ? "unavailable" : `${Math.round(latest.headingDeg)} degrees`}`,
        );
    } else {
      markerRef.current?.remove();
      markerRef.current = null;
    }

    if (
      points.length > 1 &&
      sessionId &&
      fittedSessionRef.current !== sessionId
    ) {
      fittedSessionRef.current = sessionId;
      requestAnimationFrame(fitTrack);
    }
  }, [fitTrack, mapReady, points, samples, segments, sessionId]);

  const latest = [...samples]
    .reverse()
    .find((item) => item.latitudeDeg != null && item.longitudeDeg != null);

  const centerAircraft = () => {
    if (latest?.latitudeDeg == null || latest.longitudeDeg == null) return;
    mapRef.current?.easeTo({
      center: [latest.longitudeDeg, latest.latitudeDeg],
      zoom: Math.max(mapRef.current.getZoom(), 8),
      duration: 650,
    });
  };

  const emptyTitle = !connectorOnline
    ? "CONNECTOR UNAVAILABLE"
    : state === "recording"
      ? "WAITING FOR POSITION FIX"
      : "NO ACTIVE FLIGHT";
  const emptyDescription = !connectorOnline
    ? "Route data will appear when the local connector is reachable."
    : state === "recording"
      ? "Connected to the recorder. Waiting for a valid latitude and longitude."
      : "Start a flight to plot received telemetry on the route map.";

  return (
    <section className="map-panel" aria-label="Interactive flight route map">
      <div className="map-topline">
        <div className="map-title">
          <Route size={14} />
          <span>ROUTE MAP</span>
          <span
            className={`live-tag ${state === "recording" ? "is-live" : ""}`}
          >
            {state === "recording" ? "LIVE" : "STANDBY"}
          </span>
        </div>
        <div className="map-actions">
          <button type="button" onClick={fitTrack} disabled={points.length < 2}>
            FIT TRACK
          </button>
          <button type="button" onClick={centerAircraft} disabled={!latest}>
            <Crosshair size={13} /> CENTER
          </button>
        </div>
      </div>
      <div className="map-canvas" ref={containerRef}>
        {!connectorOnline && (
          <div className="map-offline-badge">
            <WifiOff size={12} /> CONNECTOR OFFLINE
          </div>
        )}
        {mapError && (
          <div className="map-state map-error" role="status">
            <WifiOff size={20} />
            <strong>BASEMAP UNAVAILABLE</strong>
            <span>{mapError}</span>
          </div>
        )}
        {!latest && !mapError && (
          <div className="map-state" role="status">
            <MapPin size={20} />
            <strong>{emptyTitle}</strong>
            <span>{emptyDescription}</span>
          </div>
        )}
        {latest && (
          <div className="map-position-readout" aria-live="polite">
            {latest.latitudeDeg?.toFixed(4)}° /{" "}
            {latest.longitudeDeg?.toFixed(4)}°
            {latest.headingDeg != null && (
              <span>
                HDG {Math.round(latest.headingDeg).toString().padStart(3, "0")}°
              </span>
            )}
          </div>
        )}
        {!mapReady && !mapError && (
          <div className="map-loading" role="status">
            LOADING MAP TILES…
          </div>
        )}
      </div>
      <div className="map-footline">
        <span>
          {points.length.toLocaleString()} POSITION FIX
          {points.length === 1 ? "" : "ES"}
        </span>
        <span>STYLE: MAPLIBRE DEMO TILES</span>
      </div>
    </section>
  );
}
