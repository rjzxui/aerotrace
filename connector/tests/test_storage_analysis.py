from datetime import datetime, timedelta, timezone
from math import isclose
from uuid import UUID, uuid4

import pytest

from connector.analysis import Phase, _phase_candidates, analyze_flight
from connector.contracts import FlightSession, Lifecycle, Source, TelemetrySample
from connector.storage import (
    ActiveSessionExists,
    ConnectorAlreadyRunning,
    SQLiteFlightStore,
    SessionNotRecording,
)

T0 = datetime(2026, 4, 5, 12, 0, tzinfo=timezone.utc)


def make_session(source=Source.DEMO, **updates):
    data = dict(
        sessionId=uuid4(), source=source, state=Lifecycle.RECORDING,
        startedAt=T0, completedAt=None, interruptedAt=None, sampleCount=0,
        aircraft=None, error=None,
    )
    data.update(updates)
    return FlightSession(**data)


def make_sample(session, seconds, **updates):
    data = dict(
        sampleId=uuid4(), sessionId=session.sessionId, timestamp=T0 + timedelta(seconds=seconds),
        source=session.source, latitudeDeg=0.0, longitudeDeg=0.0, altitudeM=1000.0,
        headingDeg=90.0, airspeedMps=80.0, groundSpeedMps=82.0,
        verticalSpeedMps=0.0, onGround=False,
        quality="calculated" if session.source == Source.DEMO else "observed",
    )
    data.update(updates)
    return TelemetrySample(**data)


def test_recording_atomic_count_dedup_ordering_and_pagination(tmp_path):
    store = SQLiteFlightStore(tmp_path / "recording.sqlite3")
    session = make_session()
    store.create_session(session)
    late = make_sample(session, 2)
    early = make_sample(session, 1)
    duplicate_time = make_sample(session, 1, latitudeDeg=12)
    assert store.record_sample(late)[1] is True
    assert store.record_sample(early)[1] is True
    assert store.record_sample(early)[1] is False
    assert store.record_sample(duplicate_time)[1] is False
    assert store.get_session(session.sessionId).sampleCount == 2
    ordered = store.get_samples(str(session.sessionId))
    assert [s.timestamp for s in ordered] == [early.timestamp, late.timestamp]
    assert store.get_samples(str(session.sessionId), offset=1, limit=1) == [late]


def test_finalization_is_idempotent_and_blocks_late_samples(tmp_path):
    store = SQLiteFlightStore(tmp_path / "finalize.sqlite3")
    session = make_session()
    store.create_session(session)
    store.record_sample(make_sample(session, 1))
    finalizing = store.begin_finalize(session.sessionId)
    assert finalizing.state == Lifecycle.FINALIZING
    with pytest.raises(SessionNotRecording):
        store.record_sample(make_sample(session, 2))
    completed = store.complete_session(session.sessionId, T0 + timedelta(seconds=2))
    assert store.complete_session(session.sessionId) == completed
    assert completed.state == Lifecycle.COMPLETED
    assert completed.sampleCount == 1


def test_sessions_and_sources_are_isolated(tmp_path):
    store = SQLiteFlightStore(tmp_path / "isolation.sqlite3")
    demo, real = make_session(), make_session(Source.SIMCONNECT)
    store.create_session(demo)
    store.record_sample(make_sample(demo, 1))
    store.begin_finalize(demo.sessionId)
    store.complete_session(demo.sessionId)
    store.create_session(real)
    with pytest.raises(ValueError, match="source does not match"):
        store.record_sample(make_sample(real, 1, source=Source.DEMO, quality="calculated"))
    assert store.get_samples(str(real.sessionId)) == []
    assert len(store.get_samples(str(demo.sessionId))) == 1
    assert demo.sessionId != real.sessionId


def test_database_rejects_second_active_session_across_store_instances(tmp_path):
    path = tmp_path / "active-unique.sqlite3"
    first_store, second_store = SQLiteFlightStore(path), SQLiteFlightStore(path)
    first_store.create_session(make_session())
    with pytest.raises(ActiveSessionExists):
        second_store.create_session(make_session(Source.SIMCONNECT))


def test_connector_process_lock_prevents_concurrent_startup_recovery(tmp_path):
    path = tmp_path / "exclusive.sqlite3"
    first_store, second_store = SQLiteFlightStore(path), SQLiteFlightStore(path)
    first_store.acquire_process_lock()
    try:
        with pytest.raises(ConnectorAlreadyRunning):
            second_store.acquire_process_lock()
    finally:
        first_store.release_process_lock()
    second_store.acquire_process_lock()
    second_store.release_process_lock()


def test_persisted_sample_timestamps_are_normalized_to_utc(tmp_path):
    store = SQLiteFlightStore(tmp_path / "utc.sqlite3")
    session = make_session()
    store.create_session(session)
    offset_timestamp = T0.astimezone(timezone(timedelta(hours=5, minutes=30)))
    store.record_sample(make_sample(session, 1, timestamp=offset_timestamp))
    saved = store.get_samples(str(session.sessionId))[0]
    assert saved.timestamp.utcoffset() == timedelta(0)
    assert saved.timestamp.isoformat().endswith("+00:00")


def test_restart_marks_active_session_interrupted_and_repairs_count(tmp_path):
    path = tmp_path / "restart.sqlite3"
    store = SQLiteFlightStore(path)
    session = make_session()
    store.create_session(session)
    store.record_sample(make_sample(session, 1))
    # Reopening the repository simulates a connector process restart.
    recovered_store = SQLiteFlightStore(path)
    assert recovered_store.recover_interrupted() == 1
    interrupted = recovered_store.get_session(session.sessionId)
    assert interrupted.state == Lifecycle.INTERRUPTED
    assert interrupted.interruptedAt is not None
    assert interrupted.completedAt is None
    assert interrupted.sampleCount == 1
    assert recovered_store.recover_interrupted() == 0


def test_reopen_preserves_legacy_duplicate_rows(tmp_path):
    path = tmp_path / "preserve.sqlite3"
    store = SQLiteFlightStore(path)
    session = make_session()
    store.create_session(session)
    sample = make_sample(session, 1)
    store.record_sample(sample)
    # Simulate an older database that allowed duplicate timestamps.
    with store._connection() as db:
        another = make_sample(session, 1)
        db.execute(
            "INSERT INTO telemetry(sample_id,session_id,timestamp,payload) VALUES(?,?,?,?)",
            (str(another.sampleId), str(session.sessionId), sample.timestamp.isoformat(), another.model_dump_json()),
        )
    reopened = SQLiteFlightStore(path)
    assert len(reopened.get_samples(str(session.sessionId))) == 2


def completed_session(session_id=None, seconds=220):
    return FlightSession(
        sessionId=session_id or uuid4(), source=Source.DEMO, state=Lifecycle.COMPLETED,
        startedAt=T0, completedAt=T0 + timedelta(seconds=seconds), interruptedAt=None,
        sampleCount=0, aircraft=None, error=None,
    )


def test_route_distance_skips_long_gaps_and_reports_unbridged_segments():
    session = completed_session(seconds=125)
    samples = [
        make_sample(session, 0, latitudeDeg=0, longitudeDeg=0),
        make_sample(session, 1, latitudeDeg=0, longitudeDeg=0.01),
        make_sample(session, 120, latitudeDeg=1, longitudeDeg=1),
    ]
    analysis = analyze_flight(session, samples)
    assert 1110 < analysis.summary.routeDistanceM < 1115
    assert analysis.summary.routeGapCount == 1
    assert len(analysis.routeSegments) == 1
    assert any(event.type == "route_gap" for event in analysis.events)


def test_analysis_sorts_and_reports_duplicates_and_ignores_invalid_positions():
    session = completed_session(seconds=2)
    first = make_sample(session, 0, sampleId=UUID(int=1), latitudeDeg=0, longitudeDeg=0)
    second = make_sample(session, 1, sampleId=UUID(int=2), latitudeDeg=0, longitudeDeg=0.01)
    duplicate = make_sample(session, 1, sampleId=UUID(int=3), latitudeDeg=20, longitudeDeg=20)
    invalid = make_sample(session, 2, sampleId=UUID(int=4)).model_copy(update={"latitudeDeg": 91})
    result = analyze_flight(session, [invalid, duplicate, second, first])
    assert result.summary.duplicateTimestampCount == 1
    assert result.summary.sampleCount == 4
    assert result.summary.validPositionSampleCount == 2
    assert result.summary.firstPosition.latitudeDeg == 0
    assert result.summary.lastPosition.longitudeDeg == 0.01


def test_phase_rules_takeoff_climb_cruise_approach_landing_and_uncertainty():
    session = completed_session(seconds=220)
    values = []
    for sec in (0, 10, 20):
        values.append(make_sample(session, sec, onGround=True, groundSpeedMps=0, verticalSpeedMps=None))
    for sec in (30, 40, 50):
        values.append(make_sample(session, sec, onGround=False, verticalSpeedMps=2.0))
    for sec in (60, 70):
        values.append(make_sample(session, sec, onGround=False, verticalSpeedMps=0.8))
    for sec in range(80, 210, 10):
        values.append(make_sample(session, sec, onGround=False, verticalSpeedMps=-2.0))
    values.extend([
        make_sample(session, 210, onGround=True, groundSpeedMps=30, verticalSpeedMps=0),
        make_sample(session, 220, onGround=True, groundSpeedMps=1, verticalSpeedMps=0),
    ])
    result = analyze_flight(session, values)
    phases = [interval.phase for interval in result.phases]
    assert Phase.ON_GROUND in phases
    assert Phase.TAKEOFF_INITIAL_CLIMB in phases
    assert Phase.CRUISE in phases
    assert Phase.APPROACH in phases
    assert Phase.LANDING_ROLLOUT in phases
    assert result.summary.takeoffEvents == 1 and result.summary.landingEvents == 1
    assert result.summary.airborneDurationStatus == "complete"
    assert result.summary.airborneDurationSeconds == 180
    assert isclose(result.summary.recordingDurationSeconds, 220)
    assert result.summary.maximumAltitudeM == 1000
    assert result.summary.maximumAirspeedMps == 80
    assert result.summary.maximumGroundSpeedMps == 82
    assert isclose(result.summary.averageGroundSpeedMps, (18 * 82 + 31) / 23)
    assert result.summary.maximumClimbRateMps == 2
    assert result.summary.maximumDescentRateMps == 2


@pytest.mark.parametrize(
    ("vertical_speed", "expected"),
    [(0.8, Phase.CRUISE), (0.81, Phase.CLIMB), (-0.8, Phase.CRUISE), (-0.81, Phase.DESCENT)],
)
def test_phase_vertical_speed_threshold_boundaries(vertical_speed, expected):
    session = completed_session()
    sample = make_sample(session, 0, onGround=False, verticalSpeedMps=vertical_speed, altitudeM=1000)
    assert _phase_candidates([sample]) == [expected]


def test_short_phase_flicker_is_smoothed_but_sustained_phase_is_retained():
    session = completed_session(seconds=50)
    flicker = [
        make_sample(session, 0, verticalSpeedMps=2),
        make_sample(session, 1, verticalSpeedMps=0.8),
        make_sample(session, 2, verticalSpeedMps=2),
    ]
    sustained = [
        make_sample(session, 0, verticalSpeedMps=2),
        make_sample(session, 10, verticalSpeedMps=0.8),
        make_sample(session, 20, verticalSpeedMps=0.8),
        make_sample(session, 30, verticalSpeedMps=0.8),
        make_sample(session, 40, verticalSpeedMps=2),
    ]
    assert _phase_candidates(flicker) == [Phase.CLIMB, Phase.CLIMB, Phase.CLIMB]
    assert _phase_candidates(sustained)[1] == Phase.CRUISE


def test_summary_missing_data_stays_unavailable_and_duration_is_not_airborne_time():
    session = completed_session(seconds=5)
    samples = [make_sample(session, i, latitudeDeg=None, longitudeDeg=None,
                           altitudeM=None, airspeedMps=None, groundSpeedMps=None,
                           verticalSpeedMps=None, onGround=None) for i in (0, 5)]
    result = analyze_flight(session, samples)
    assert result.summary.recordingDurationSeconds == 5
    assert result.summary.airborneDurationSeconds is None
    assert result.summary.maximumAltitudeM is None
    assert result.summary.averageGroundSpeedMps is None
    assert result.summary.firstPosition is None
    assert result.summary.routeDistanceM == 0
    assert Phase.UNCERTAIN in [interval.phase for interval in result.phases]


def test_analysis_rejects_samples_from_another_provider_or_session():
    session = completed_session()
    other = make_session(Source.SIMCONNECT)
    with pytest.raises(ValueError, match="belong to the requested flight"):
        analyze_flight(session, [make_sample(other, 0)])


def test_naive_telemetry_timestamps_are_rejected():
    session = make_session()
    with pytest.raises(ValueError, match="UTC offset"):
        make_sample(session, 0, timestamp=datetime(2026, 4, 5, 12, 0))


def test_naive_session_timestamps_are_rejected():
    with pytest.raises(ValueError, match="UTC offset"):
        make_session(startedAt=datetime(2026, 4, 5, 12, 0))
