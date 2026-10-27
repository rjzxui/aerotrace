"""Deterministic post-flight summaries derived only from persisted observations."""
from __future__ import annotations

import math
from collections import Counter
from datetime import datetime, timezone
from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from .contracts import FlightSession, Lifecycle, TelemetrySample

EARTH_RADIUS_M = 6_371_008.8
MAX_ROUTE_GAP_SECONDS = 30.0
MAX_PHASE_GAP_SECONDS = 30.0
MIN_PHASE_SECONDS = 10.0
APPROACH_MIN_SECONDS = 30.0
INITIAL_CLIMB_SECONDS = 180.0
VERTICAL_RATE_THRESHOLD_MPS = 0.8


class Phase(StrEnum):
    ON_GROUND = "on_ground"
    TAKEOFF_INITIAL_CLIMB = "takeoff_initial_climb"
    CLIMB = "climb"
    CRUISE = "cruise"
    DESCENT = "descent"
    APPROACH = "approach"
    LANDING_ROLLOUT = "landing_rollout"
    UNCERTAIN = "uncertain"


class FlightEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: str
    timestamp: datetime
    endTimestamp: datetime | None = None
    confidence: Literal["high", "medium", "low"]
    details: str


class PhaseInterval(BaseModel):
    model_config = ConfigDict(extra="forbid")
    phase: Phase
    startedAt: datetime
    endedAt: datetime
    durationSeconds: float
    confidence: Literal["high", "medium", "low"]
    uncertainty: str | None = None


class Position(BaseModel):
    model_config = ConfigDict(extra="forbid")
    timestamp: datetime
    latitudeDeg: float
    longitudeDeg: float


class RouteSegment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    coordinates: list[tuple[float, float]]  # GeoJSON order: longitude, latitude
    startedAt: datetime
    endedAt: datetime


class FlightSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    calculationSource: Literal["calculated_from_persisted_samples"] = "calculated_from_persisted_samples"
    inputProvenance: Literal["observed", "calculated", "mixed", "unavailable"]
    recordingDurationSeconds: float | None
    recordingDurationStatus: Literal["complete", "interrupted", "partial", "active", "unavailable"]
    airborneDurationSeconds: float | None
    airborneDurationStatus: Literal["complete", "partial", "unavailable"]
    routeDistanceM: float
    routeDistanceStatus: Literal["observed_segments_only", "no_valid_segments"]
    maximumAltitudeM: float | None
    maximumAirspeedMps: float | None
    maximumGroundSpeedMps: float | None
    averageGroundSpeedMps: float | None
    maximumClimbRateMps: float | None
    maximumDescentRateMps: float | None  # Positive magnitude.
    sampleCount: int
    uniqueSampleCount: int
    validPositionSampleCount: int
    duplicateTimestampCount: int
    sampleCoveragePercent: float | None
    positionCoveragePercent: float | None
    phaseTimeSeconds: dict[str, float]
    firstPosition: Position | None
    lastPosition: Position | None
    takeoffEvents: int
    landingEvents: int
    routeGapCount: int


class FlightAnalysis(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sessionId: UUID
    recordingStatus: Literal["complete", "interrupted", "active", "error"]
    summary: FlightSummary
    phases: list[PhaseInterval]
    events: list[FlightEvent]
    routeSegments: list[RouteSegment]


class FlightReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session: FlightSession
    recordingStatus: Literal["complete", "interrupted", "active", "error"]
    summary: FlightSummary


def _distance_m(a: TelemetrySample, b: TelemetrySample) -> float:
    lat1, lat2 = math.radians(a.latitudeDeg), math.radians(b.latitudeDeg)
    dlat = lat2 - lat1
    dlon = math.radians(b.longitudeDeg - a.longitudeDeg)
    # Wrap longitude difference across the antimeridian.
    dlon = (dlon + math.pi) % (2 * math.pi) - math.pi
    hav = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(min(1.0, max(0.0, hav))))


def _duration(samples: list[TelemetrySample], start: int, end: int, max_gap: float) -> float:
    return sum(
        (samples[i + 1].timestamp - samples[i].timestamp).total_seconds()
        for i in range(start, end)
        if 0 < (samples[i + 1].timestamp - samples[i].timestamp).total_seconds() <= max_gap
    )


def _phase_candidates(samples: list[TelemetrySample]) -> list[Phase]:
    labels: list[Phase] = []
    saw_ground = False
    first_airborne: datetime | None = None
    rollout_active = False
    for sample in samples:
        if sample.onGround is True:
            just_landed = first_airborne is not None
            if just_landed:
                rollout_active = True
                first_airborne = None
            saw_ground = True
            if rollout_active and sample.groundSpeedMps is not None and sample.groundSpeedMps > 2:
                labels.append(Phase.LANDING_ROLLOUT)
            else:
                rollout_active = False
                labels.append(Phase.ON_GROUND)
            continue
        if sample.onGround is False:
            if first_airborne is None:
                first_airborne = sample.timestamp
            rollout_active = False
            vs = sample.verticalSpeedMps
            if vs is None:
                labels.append(Phase.UNCERTAIN)
            elif vs > VERTICAL_RATE_THRESHOLD_MPS:
                elapsed = (sample.timestamp - first_airborne).total_seconds()
                labels.append(Phase.TAKEOFF_INITIAL_CLIMB if saw_ground and elapsed <= INITIAL_CLIMB_SECONDS else Phase.CLIMB)
            elif vs < -VERTICAL_RATE_THRESHOLD_MPS:
                labels.append(Phase.DESCENT)
            elif sample.altitudeM is not None:
                labels.append(Phase.CRUISE)
            else:
                labels.append(Phase.UNCERTAIN)
            continue
        vs = sample.verticalSpeedMps
        if vs is not None and vs > VERTICAL_RATE_THRESHOLD_MPS:
            labels.append(Phase.CLIMB)
        elif vs is not None and vs < -VERTICAL_RATE_THRESHOLD_MPS:
            labels.append(Phase.DESCENT)
        else:
            labels.append(Phase.UNCERTAIN)

    # A final, sustained descent immediately followed by an observed on-ground
    # fix is labelled approach retrospectively. MSL altitude is not AGL, so this
    # remains a medium-confidence classification.
    landing_index = next((i for i, phase in enumerate(labels) if phase == Phase.LANDING_ROLLOUT), None)
    if landing_index is not None:
        cursor = landing_index - 1
        while cursor >= 0 and labels[cursor] == Phase.DESCENT:
            cursor -= 1
        start = cursor + 1
        if start < landing_index and _duration(samples, start, landing_index, MAX_PHASE_GAP_SECONDS) >= APPROACH_MIN_SECONDS:
            for i in range(start, landing_index):
                labels[i] = Phase.APPROACH

    # Remove short isolated non-ground phase flickers (hysteresis) without
    # smoothing across telemetry gaps or across ground/air transitions.
    runs: list[tuple[int, int, Phase]] = []
    start = 0
    for index in range(1, len(labels) + 1):
        if index == len(labels) or labels[index] != labels[start]:
            runs.append((start, index, labels[start]))
            start = index
    for run_index in range(1, len(runs) - 1):
        run_start, run_end, phase = runs[run_index]
        left_start, left_end, left_phase = runs[run_index - 1]
        right_start, right_end, right_phase = runs[run_index + 1]
        if phase in {Phase.ON_GROUND, Phase.LANDING_ROLLOUT, Phase.UNCERTAIN} or left_phase != right_phase:
            continue
        run_duration = _duration(samples, run_start, run_end - 1, MAX_PHASE_GAP_SECONDS)
        left_gap = (samples[run_start].timestamp - samples[left_end - 1].timestamp).total_seconds()
        right_gap = (samples[right_start].timestamp - samples[run_end - 1].timestamp).total_seconds()
        if run_duration < MIN_PHASE_SECONDS and left_gap <= MAX_PHASE_GAP_SECONDS and right_gap <= MAX_PHASE_GAP_SECONDS:
            labels[run_start:run_end] = [left_phase] * (run_end - run_start)
    return labels


def _phase_intervals(samples: list[TelemetrySample], labels: list[Phase]) -> list[PhaseInterval]:
    if not samples:
        return []
    intervals: list[PhaseInterval] = []
    start = 0
    for i in range(1, len(samples) + 1):
        split = i == len(samples)
        if not split:
            gap = (samples[i].timestamp - samples[i - 1].timestamp).total_seconds()
            split = labels[i] != labels[i - 1] or gap > MAX_PHASE_GAP_SECONDS
        if not split:
            continue
        phase = labels[start]
        end_index = i - 1
        duration = _duration(samples, start, end_index, MAX_PHASE_GAP_SECONDS)
        confidence: Literal["high", "medium", "low"] = "high"
        uncertainty = None
        if phase == Phase.UNCERTAIN:
            confidence, uncertainty = "low", "The available observed fields do not support a phase classification."
        elif phase == Phase.APPROACH:
            confidence, uncertainty = "medium", "Final descent before observed on-ground status; no AGL measurement is available."
        elif any(samples[j].onGround is None for j in range(start, i)):
            confidence, uncertainty = "medium", "On-ground state was unavailable for part of this interval."
        intervals.append(PhaseInterval(
            phase=phase, startedAt=samples[start].timestamp,
            endedAt=samples[end_index].timestamp, durationSeconds=duration,
            confidence=confidence, uncertainty=uncertainty,
        ))
        start = i
    return intervals


def analyze_flight(session: FlightSession, telemetry: list[TelemetrySample], now: datetime | None = None) -> FlightAnalysis:
    """Analyze stored samples; never interpolate a missing measurement or route segment."""
    now = now or datetime.now(timezone.utc)
    if any(sample.sessionId != session.sessionId or sample.source != session.source for sample in telemetry):
        raise ValueError("Analysis samples must belong to the requested flight and provider")
    ordered = sorted(telemetry, key=lambda sample: (sample.timestamp, str(sample.sampleId)))
    # Existing databases may have equal timestamp observations. Retain the first
    # deterministically for analysis and report the omitted duplicate count.
    unique: list[TelemetrySample] = []
    seen_timestamps: set[datetime] = set()
    duplicate_count = 0
    seen_ids: set[UUID] = set()
    for sample in ordered:
        if sample.sampleId in seen_ids or sample.timestamp in seen_timestamps:
            duplicate_count += 1
            continue
        seen_ids.add(sample.sampleId)
        seen_timestamps.add(sample.timestamp)
        unique.append(sample)
    samples = unique

    events: list[FlightEvent] = []
    if session.startedAt:
        events.append(FlightEvent(type="recording_started", timestamp=session.startedAt, confidence="high", details=f"{session.source.value} recording started."))
    if session.completedAt:
        events.append(FlightEvent(type="recording_completed", timestamp=session.completedAt, confidence="high", details="Recording was finalized."))
    elif session.state == Lifecycle.INTERRUPTED:
        interrupted_at = session.interruptedAt or (samples[-1].timestamp if samples else now)
        events.append(FlightEvent(type="recording_interrupted", timestamp=interrupted_at, confidence="high", details="Connector restarted before the session was finalized."))

    takeoffs: list[datetime] = []
    landings: list[datetime] = []
    completed_airborne_intervals: list[tuple[datetime, datetime]] = []
    pending_takeoff: datetime | None = None
    for prev, current in zip(samples, samples[1:]):
        delta = (current.timestamp - prev.timestamp).total_seconds()
        if delta > MAX_PHASE_GAP_SECONDS:
            events.append(FlightEvent(type="telemetry_gap", timestamp=prev.timestamp, endTimestamp=current.timestamp, confidence="high", details=f"No recorded samples for {delta:.1f} seconds."))
        if 0 < delta <= MAX_ROUTE_GAP_SECONDS:
            if prev.onGround is True and current.onGround is False:
                takeoffs.append(current.timestamp)
                pending_takeoff = current.timestamp
                events.append(FlightEvent(type="takeoff", timestamp=current.timestamp, confidence="high", details="Observed on-ground to airborne transition."))
            if prev.onGround is False and current.onGround is True:
                landings.append(current.timestamp)
                if pending_takeoff is not None:
                    completed_airborne_intervals.append((pending_takeoff, current.timestamp))
                    pending_takeoff = None
                events.append(FlightEvent(type="landing", timestamp=current.timestamp, confidence="high", details="Observed airborne to on-ground transition."))

    positions = [sample for sample in samples if _valid_position(sample)]
    route_distance = 0.0
    route_gaps = 0
    segments: list[RouteSegment] = []
    segment_points: list[TelemetrySample] = []
    previous_fix: TelemetrySample | None = None
    for position in positions:
        if previous_fix is None:
            segment_points = [position]
            previous_fix = position
            continue
        previous = previous_fix
        delta = (position.timestamp - previous.timestamp).total_seconds()
        if delta > MAX_ROUTE_GAP_SECONDS:
            route_gaps += 1
            events.append(FlightEvent(type="route_gap", timestamp=previous.timestamp, endTimestamp=position.timestamp, confidence="high", details=f"Route distance excludes this {delta:.1f}-second position gap; no path was interpolated."))
            if len(segment_points) >= 2:
                segments.append(_route_segment(segment_points))
            segment_points = [position]
            previous_fix = position
            continue
        if delta <= 0:
            continue
        distance = _distance_m(previous, position)
        if distance > 0:
            route_distance += distance
        if (position.latitudeDeg, position.longitudeDeg) != (previous.latitudeDeg, previous.longitudeDeg):
            segment_points.append(position)
        previous_fix = position
    if len(segment_points) >= 2:
        segments.append(_route_segment(segment_points))

    labels = _phase_candidates(samples)
    phases = _phase_intervals(samples, labels)
    phase_times = dict(Counter())
    for interval in phases:
        phase_times[interval.phase.value] = phase_times.get(interval.phase.value, 0.0) + interval.durationSeconds

    start = session.startedAt
    active = session.state in {Lifecycle.RECORDING, Lifecycle.FINALIZING}
    if session.completedAt:
        duration_end, duration_status = session.completedAt, "complete"
    elif active:
        duration_end, duration_status = now, "active"
    elif session.state == Lifecycle.INTERRUPTED:
        duration_end = samples[-1].timestamp if samples else None
        duration_status = "interrupted"
    elif samples:
        duration_end, duration_status = samples[-1].timestamp, "partial"
    else:
        duration_end, duration_status = None, "unavailable"
    recording_duration = max(0.0, (duration_end - start).total_seconds()) if start and duration_end else None
    airborne_seconds: float | None = None
    airborne_status: Literal["complete", "partial", "unavailable"] = "unavailable"
    if completed_airborne_intervals or pending_takeoff:
        airborne_seconds = sum((end_time - start_time).total_seconds() for start_time, end_time in completed_airborne_intervals)
        if pending_takeoff is not None:
            last_airborne = next((s.timestamp for s in reversed(samples) if s.onGround is False and s.timestamp >= pending_takeoff), None)
            if last_airborne is not None:
                airborne_seconds += max(0.0, (last_airborne - pending_takeoff).total_seconds())
        airborne_status = "complete" if pending_takeoff is None and completed_airborne_intervals else "partial"

    sample_count = len(telemetry)
    qualities = {sample.quality for sample in samples}
    provenance = "mixed" if len(qualities) > 1 else next(iter(qualities), "unavailable")
    expected_samples = max(1, math.floor(recording_duration) + 1) if recording_duration is not None and duration_status in {"complete", "active"} else None
    unique_count = len(samples)
    sample_coverage = min(100.0, 100 * unique_count / expected_samples) if expected_samples else None
    position_coverage = 100 * len(positions) / unique_count if unique_count else None
    ground_speeds = [s.groundSpeedMps for s in samples if s.groundSpeedMps is not None]
    vertical = [s.verticalSpeedMps for s in samples if s.verticalSpeedMps is not None]

    summary = FlightSummary(
        inputProvenance=provenance,
        recordingDurationSeconds=recording_duration, recordingDurationStatus=duration_status,
        airborneDurationSeconds=airborne_seconds, airborneDurationStatus=airborne_status,
        routeDistanceM=route_distance,
        routeDistanceStatus="observed_segments_only" if route_distance > 0 else "no_valid_segments",
        maximumAltitudeM=max((s.altitudeM for s in samples if s.altitudeM is not None), default=None),
        maximumAirspeedMps=max((s.airspeedMps for s in samples if s.airspeedMps is not None), default=None),
        maximumGroundSpeedMps=max(ground_speeds, default=None),
        averageGroundSpeedMps=sum(ground_speeds) / len(ground_speeds) if ground_speeds else None,
        maximumClimbRateMps=max((v for v in vertical if v > 0), default=None),
        maximumDescentRateMps=max((-v for v in vertical if v < 0), default=None),
        sampleCount=sample_count, uniqueSampleCount=unique_count, validPositionSampleCount=len(positions),
        duplicateTimestampCount=duplicate_count, sampleCoveragePercent=sample_coverage,
        positionCoveragePercent=position_coverage, phaseTimeSeconds=phase_times,
        firstPosition=_position(positions[0]) if positions else None,
        lastPosition=_position(positions[-1]) if positions else None,
        takeoffEvents=len(takeoffs), landingEvents=len(landings), routeGapCount=route_gaps,
    )
    status: Literal["complete", "interrupted", "active", "error"]
    if session.state == Lifecycle.COMPLETED:
        status = "complete"
    elif session.state == Lifecycle.INTERRUPTED:
        status = "interrupted"
    elif session.state in {Lifecycle.RECORDING, Lifecycle.FINALIZING}:
        status = "active"
    else:
        status = "error"
    events.sort(key=lambda event: (event.timestamp, event.type))
    return FlightAnalysis(sessionId=session.sessionId, recordingStatus=status, summary=summary, phases=phases, events=events, routeSegments=segments)


def _position(sample: TelemetrySample) -> Position:
    return Position(timestamp=sample.timestamp, latitudeDeg=float(sample.latitudeDeg), longitudeDeg=float(sample.longitudeDeg))


def _valid_position(sample: TelemetrySample) -> bool:
    return (
        sample.latitudeDeg is not None and sample.longitudeDeg is not None
        and -90 <= sample.latitudeDeg <= 90 and -180 <= sample.longitudeDeg <= 180
        and math.isfinite(sample.latitudeDeg) and math.isfinite(sample.longitudeDeg)
    )


def _route_segment(samples: list[TelemetrySample]) -> RouteSegment:
    return RouteSegment(
        coordinates=[(float(s.longitudeDeg), float(s.latitudeDeg)) for s in samples],
        startedAt=samples[0].timestamp,
        endedAt=samples[-1].timestamp,
    )
