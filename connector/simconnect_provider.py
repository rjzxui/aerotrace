"""Optional adapter for odwdinc/Python-SimConnect (no simulator required to import)."""
from __future__ import annotations

import math
import sys
from contextlib import suppress
from datetime import datetime, timezone
from enum import IntEnum
from typing import Any, Protocol
from uuid import UUID, uuid4

from .contracts import Source, TelemetrySample
from .providers import TelemetryProvider

KNOT_TO_MPS = 0.5144444444444445
FEET_TO_METRES = 0.3048
FPM_TO_MPS = 0.00508
RAD_TO_DEG = 180 / math.pi


class RequestClient(Protocol):
    def get(self, name: str) -> Any: ...


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if math.isfinite(result) else None


def _bounded(value: float | None, minimum: float, maximum: float) -> float | None:
    return value if value is not None and minimum <= value <= maximum else None


def subscribe_pause_state(connection: Any) -> None:
    """Subscribe to SimConnect's Pause event, which immediately reports current state."""
    event_enum = connection.dll.EventID
    event_name = "AEROTRACE_PAUSE_STATE"
    members = {member.name: member.value for member in event_enum}
    members[event_name] = max(members.values(), default=-1) + 1
    connection.dll.EventID = IntEnum(event_enum.__name__, members)
    event_id = members[event_name]
    original_handler = connection.handle_id_event

    def handle_event(event: Any) -> None:
        if event.uEventID == event_id:
            connection.paused = bool(event.dwData)
            return
        original_handler(event)

    connection.handle_id_event = handle_event
    result = connection.dll.SubscribeToSystemEvent(connection.hSimConnect, event_id, b"Pause")
    if not connection.IsHR(result, 0):
        raise RuntimeError("Could not subscribe to SimConnect pause state")


def map_simvars(raw: dict[str, Any], session_id: UUID, timestamp: datetime | None = None) -> TelemetrySample:
    """Map wrapper values (units below) to SI. Timestamp is local UTC observation time."""
    lat = _bounded(_number(raw.get("PLANE_LATITUDE")), -90, 90)
    lon = _bounded(_number(raw.get("PLANE_LONGITUDE")), -180, 180)
    altitude_ft = _number(raw.get("PLANE_ALTITUDE"))  # feet MSL, not AGL
    heading_rad = _number(raw.get("PLANE_HEADING_DEGREES_TRUE"))  # wrapper requests radians
    heading_rad = _bounded(heading_rad, 0, math.tau)
    heading = _number(heading_rad * RAD_TO_DEG) if heading_rad is not None else None
    heading = heading % 360 if heading is not None else None
    airspeed = _number(raw.get("AIRSPEED_INDICATED"))  # knots
    groundspeed = _number(raw.get("GROUND_VELOCITY"))  # knots
    vertical_fpm = _number(raw.get("VERTICAL_SPEED"))  # feet/minute
    ground = raw.get("SIM_ON_GROUND")
    on_ground = bool(ground) if isinstance(ground, (bool, int, float)) and ground in (0, 1, 0.0, 1.0, False, True) else None
    return TelemetrySample(
        sampleId=uuid4(), sessionId=session_id,
        timestamp=timestamp or datetime.now(timezone.utc), source=Source.SIMCONNECT,
        latitudeDeg=lat, longitudeDeg=lon,
        altitudeM=_bounded(_number(altitude_ft * FEET_TO_METRES) if altitude_ft is not None else None, -1000, 100000),
        headingDeg=heading,
        airspeedMps=_bounded(_number(airspeed * KNOT_TO_MPS) if airspeed is not None else None, 0, 2000),
        groundSpeedMps=_bounded(_number(groundspeed * KNOT_TO_MPS) if groundspeed is not None else None, 0, 2000),
        verticalSpeedMps=_bounded(_number(vertical_fpm * FPM_TO_MPS) if vertical_fpm is not None else None, -300, 300),
        onGround=on_ground, quality="observed",
    )


class SimConnectTelemetryProvider(TelemetryProvider):
    """Windows-only provider. Package import and DLL access are deferred until connect."""
    source = Source.SIMCONNECT
    def __init__(self) -> None:
        self.connection: Any = None
        self.requests: Any = None
        self.aircraft: str | None = None

    def connect(self) -> None:
        if sys.platform != "win32":
            raise RuntimeError("SimConnect is available only on Windows")
        try:
            from SimConnect import AircraftRequests, SimConnect
        except ImportError as exc:
            raise RuntimeError("Python-SimConnect is not installed; install requirements-msfs.txt") from exc
        connection = SimConnect(auto_connect=True)
        if not getattr(connection, "ok", False):
            with suppress(Exception):
                connection.exit()
            raise ConnectionError("MSFS SimConnect endpoint did not open")
        try:
            subscribe_pause_state(connection)
        except Exception:
            with suppress(Exception):
                connection.exit()
            raise
        self.connection = connection
        self.requests = AircraftRequests(connection, _time=250, _attemps=2)

    def is_connected(self) -> bool:
        return bool(self.connection is not None and getattr(self.connection, "ok", False) and not getattr(self.connection, "quit", 0))

    def is_paused(self) -> bool:
        if self.connection is None:
            return False
        # Python-SimConnect subscribes to paused/unpaused system events on connect.
        return bool(getattr(self.connection, "paused", False))

    def next_sample(self, session_id: UUID) -> TelemetrySample:
        if not self.is_connected() or self.requests is None:
            raise ConnectionError("MSFS SimConnect connection was lost")
        names = (
            "PLANE_LATITUDE", "PLANE_LONGITUDE", "PLANE_ALTITUDE",
            "PLANE_HEADING_DEGREES_TRUE", "AIRSPEED_INDICATED", "GROUND_VELOCITY",
            "VERTICAL_SPEED", "SIM_ON_GROUND",
        )
        raw = {name: self.requests.get(name) for name in names}
        title = self.requests.get("TITLE")
        if isinstance(title, bytes):
            title = title.decode("utf-8", errors="replace")
        self.aircraft = title.strip() if isinstance(title, str) and title.strip() else None
        return map_simvars(raw, session_id)

    def disconnect(self) -> None:
        connection, self.connection = self.connection, None
        self.requests = None
        if connection is not None:
            connection.exit()
