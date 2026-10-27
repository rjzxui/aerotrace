from datetime import datetime, timezone
from enum import IntEnum
from math import isclose
from uuid import uuid4

import pytest

from connector.contracts import Source
from connector.simconnect_provider import (
    FEET_TO_METRES, FPM_TO_MPS, KNOT_TO_MPS, RAD_TO_DEG,
    SimConnectTelemetryProvider, map_simvars,
    subscribe_pause_state,
)


def test_maps_wrapper_units_to_canonical_contract():
    session_id = uuid4()
    timestamp = datetime(2026, 1, 2, tzinfo=timezone.utc)
    sample = map_simvars({
        "PLANE_LATITUDE": 40.7, "PLANE_LONGITUDE": -73.8,
        "PLANE_ALTITUDE": 10000, "PLANE_HEADING_DEGREES_TRUE": 1.2,
        "AIRSPEED_INDICATED": 100, "GROUND_VELOCITY": 110,
        "VERTICAL_SPEED": 600, "SIM_ON_GROUND": 0,
    }, session_id, timestamp)
    assert sample.source == Source.SIMCONNECT
    assert sample.timestamp == timestamp
    assert isclose(sample.altitudeM, 10000 * FEET_TO_METRES)
    assert isclose(sample.headingDeg, 1.2 * RAD_TO_DEG)
    assert isclose(sample.airspeedMps, 100 * KNOT_TO_MPS)
    assert isclose(sample.groundSpeedMps, 110 * KNOT_TO_MPS)
    assert isclose(sample.verticalSpeedMps, 600 * FPM_TO_MPS)
    assert sample.onGround is False and sample.quality == "observed"


def test_missing_and_invalid_simvars_remain_unavailable():
    sample = map_simvars({
        "PLANE_LATITUDE": 91, "PLANE_LONGITUDE": float("nan"),
        "PLANE_ALTITUDE": float("inf"), "PLANE_HEADING_DEGREES_TRUE": "bad",
        "AIRSPEED_INDICATED": -4, "GROUND_VELOCITY": None,
        "VERTICAL_SPEED": 999999, "SIM_ON_GROUND": 2,
    }, uuid4())
    assert sample.latitudeDeg is None and sample.longitudeDeg is None
    assert sample.altitudeM is None and sample.headingDeg is None
    assert sample.airspeedMps is None and sample.groundSpeedMps is None
    assert sample.verticalSpeedMps is None and sample.onGround is None


def test_non_windows_connection_fails_explicitly(monkeypatch):
    monkeypatch.setattr("connector.simconnect_provider.sys.platform", "linux")
    with pytest.raises(RuntimeError, match="only on Windows"):
        SimConnectTelemetryProvider().connect()


def test_real_provider_does_not_emit_if_connection_lost():
    provider = SimConnectTelemetryProvider()
    with pytest.raises(ConnectionError, match="lost"):
        provider.next_sample(uuid4())


def test_pause_subscription_uses_immediate_simconnect_pause_state():
    event_enum = IntEnum("EventID", {"KNOWN": 0})

    class FakeConnection:
        paused = False
        hSimConnect = object()

        class Dll:
            EventID = event_enum

            @staticmethod
            def SubscribeToSystemEvent(_handle, _event, event_name):
                assert event_name == b"Pause"
                return 0

        dll = Dll()

        @staticmethod
        def IsHR(result, expected):
            return result == expected

        @staticmethod
        def handle_id_event(_event):
            return None

    connection = FakeConnection()
    subscribe_pause_state(connection)
    pause_event = type("Event", (), {"uEventID": 1, "dwData": 1})()
    connection.handle_id_event(pause_event)
    assert connection.paused is True
    pause_event.dwData = 0
    connection.handle_id_event(pause_event)
    assert connection.paused is False
