"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { Crosshair, MapPin, WifiOff } from "lucide-react";
import type { FlightAnalysis, TelemetrySample } from "@/lib/contracts";

const STYLE_URL = "https://demotiles.maplibre.org/style.json";

function markerElement(className: string, label: string, content: string) {
  const element = document.createElement("div");
  element.className = className;
  element.setAttribute("role", "img");
  element.setAttribute("aria-label", label);
  element.textContent = content;
  return element;
}

export default function FlightReplayMap({
  analysis,
  selectedSample,
}: {
  analysis: FlightAnalysis;
  selectedSample: TelemetrySample | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const startMarkerRef = useRef<Marker | null>(null);
  const endMarkerRef = useRef<Marker | null>(null);
  const aircraftMarkerRef = useRef<Marker | null>(null);
  const fittedSessionRef = useRef<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  const feature = useMemo<Feature<MultiLineString>>(
    () => ({
      type: "Feature",
      properties: {},
      geometry: {
        type: "MultiLineString",
        coordinates: analysis.routeSegments.map(
          (segment) => segment.coordinates,
        ),
      },
    }),
    [analysis.routeSegments],
  );

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let resizeFrame: number | null = null;
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
      if (disposed) return;
      map.addSource("flight-replay-route", { type: "geojson", data: feature });
      map.addLayer({
        id: "flight-replay-route-line",
        type: "line",
        source: "flight-replay-route",
        paint: {
          "line-color": "#e0bd7e",
          "line-width": 3,
          "line-opacity": 0.94,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      setMapReady(true);
      setMapError(null);
      resizeFrame = requestAnimationFrame(() => {
        if (!disposed) map.resize();
      });
    });
    map.on("error", () => {
      if (!disposed && !map.isStyleLoaded()) {
        setMapError(
          "The map style or tiles could not be reached. Recorded telemetry is still available.",
        );
      }
    });
    const observer = new ResizeObserver(() => {
      if (!disposed) map.resize();
    });
    observer.observe(containerRef.current);
    return () => {
      disposed = true;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      startMarkerRef.current?.remove();
      endMarkerRef.current?.remove();
      aircraftMarkerRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
  }, [feature]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    (
      map.getSource("flight-replay-route") as GeoJSONSource | undefined
    )?.setData(feature);

    const first = analysis.summary.firstPosition;
    const last = analysis.summary.lastPosition;
    if (first) {
      if (!startMarkerRef.current) {
        startMarkerRef.current = new Marker({
          element: markerElement(
            "replay-endpoint replay-start",
            "First recorded position",
            "S",
          ),
          anchor: "center",
        })
          .setLngLat([first.longitudeDeg, first.latitudeDeg])
          .addTo(map);
      }
      startMarkerRef.current.setLngLat([first.longitudeDeg, first.latitudeDeg]);
    }
    if (last) {
      if (!endMarkerRef.current) {
        endMarkerRef.current = new Marker({
          element: markerElement(
            "replay-endpoint replay-end",
            "Last recorded position",
            "E",
          ),
          anchor: "center",
        })
          .setLngLat([last.longitudeDeg, last.latitudeDeg])
          .addTo(map);
      }
      endMarkerRef.current.setLngLat([last.longitudeDeg, last.latitudeDeg]);
    }

    if (
      selectedSample?.latitudeDeg != null &&
      selectedSample.longitudeDeg != null
    ) {
      if (!aircraftMarkerRef.current) {
        aircraftMarkerRef.current = new Marker({
          element: markerElement(
            "replay-aircraft-marker",
            "Selected recorded aircraft position",
            "▲",
          ),
          anchor: "center",
          rotationAlignment: "map",
        })
          .setLngLat([selectedSample.longitudeDeg, selectedSample.latitudeDeg])
          .addTo(map);
      }
      aircraftMarkerRef.current
        .setLngLat([selectedSample.longitudeDeg, selectedSample.latitudeDeg])
        .setRotation(selectedSample.headingDeg ?? 0);
    } else {
      aircraftMarkerRef.current?.remove();
      aircraftMarkerRef.current = null;
    }

    if (fittedSessionRef.current !== analysis.sessionId) {
      fittedSessionRef.current = analysis.sessionId;
      const coordinates = analysis.routeSegments.flatMap(
        (segment) => segment.coordinates,
      );
      if (coordinates.length > 1) {
        const bounds = coordinates.reduce(
          (current, point) => current.extend(point),
          new LngLatBounds(coordinates[0], coordinates[0]),
        );
        map.fitBounds(bounds, { padding: 76, maxZoom: 8, duration: 650 });
      } else if (first) {
        map.easeTo({
          center: [first.longitudeDeg, first.latitudeDeg],
          zoom: 8,
          duration: 650,
        });
      }
    }
  }, [analysis, feature, mapReady, selectedSample]);

  const centerSelected = () => {
    if (
      selectedSample?.latitudeDeg == null ||
      selectedSample.longitudeDeg == null
    )
      return;
    mapRef.current?.easeTo({
      center: [selectedSample.longitudeDeg, selectedSample.latitudeDeg],
      zoom: Math.max(mapRef.current.getZoom(), 8),
      duration: 500,
    });
  };

  return (
    <section
      className="map-panel replay-map-panel"
      aria-label="Recorded flight route replay map"
    >
      <div className="map-topline">
        <div className="map-title">
          <MapPin size={14} />
          <span>RECORDED ROUTE</span>
          <span className="live-tag">PERSISTED TRACK</span>
        </div>
        <div className="map-actions">
          <button
            type="button"
            onClick={centerSelected}
            disabled={!selectedSample || selectedSample.latitudeDeg == null}
          >
            <Crosshair size={13} /> CENTER SELECTED
          </button>
        </div>
      </div>
      <div className="map-canvas replay-map-canvas" ref={containerRef}>
        {mapError && (
          <div className="map-state map-error" role="status">
            <WifiOff size={20} />
            <strong>BASEMAP UNAVAILABLE</strong>
            <span>{mapError}</span>
          </div>
        )}
        {!analysis.summary.firstPosition && !mapError && (
          <div className="map-state" role="status">
            <MapPin size={20} />
            <strong>NO RECORDED POSITION</strong>
            <span>
              This session contains no valid latitude and longitude fixes.
            </span>
          </div>
        )}
        {selectedSample && (
          <div className="map-position-readout" role="status">
            {selectedSample.latitudeDeg == null ||
            selectedSample.longitudeDeg == null
              ? "POSITION UNAVAILABLE AT SELECTED SAMPLE"
              : `${selectedSample.latitudeDeg.toFixed(4)}°, ${selectedSample.longitudeDeg.toFixed(4)}°`}
            <span>
              {new Date(selectedSample.timestamp).toLocaleTimeString("en-GB", {
                timeZone: "UTC",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}{" "}
              UTC
            </span>
          </div>
        )}
        {!mapReady && !mapError && (
          <div className="map-loading" role="status">
            LOADING MAP TILES…
          </div>
        )}
      </div>
      <div className="map-footline replay-map-legend">
        <span>
          <i className="legend-start">S</i> FIRST FIX
        </span>
        <span>
          <i className="legend-end">E</i> LAST FIX
        </span>
        <span>
          <i className="legend-selected">▲</i> SELECTED POSITION
        </span>
        <span>
          {analysis.summary.routeGapCount.toLocaleString()} RECORDED ROUTE GAPS
        </span>
      </div>
    </section>
  );
}
