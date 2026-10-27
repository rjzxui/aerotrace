"""Versioned telemetry wire contracts. All measurements carry explicit SI units."""
from datetime import datetime, timezone
from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Source(StrEnum):
    DEMO = "demo"
    SIMCONNECT = "simconnect"


class Lifecycle(StrEnum):
    DISCONNECTED = "disconnected"
    CONNECTED = "connected"
    RECORDING = "recording"
    FINALIZING = "finalizing"
    COMPLETED = "completed"
    INTERRUPTED = "interrupted"
    ERROR = "error"


class SimulatorState(StrEnum):
    NOT_DETECTED = "not_detected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    WAITING = "waiting_for_flight"
    RECORDING = "recording"
    LOST = "connection_lost"
    RECONNECTING = "reconnecting"
    ERROR = "error"


class TelemetrySample(BaseModel):
    """One timestamped observation. Null measurements mean unavailable, never zero."""

    model_config = ConfigDict(extra="forbid")
    schemaVersion: Literal["1.0"] = "1.0"
    sampleId: UUID
    sessionId: UUID
    timestamp: datetime
    source: Source
    latitudeDeg: float | None = Field(None, ge=-90, le=90)
    longitudeDeg: float | None = Field(None, ge=-180, le=180)
    altitudeM: float | None = None
    headingDeg: float | None = Field(None, ge=0, lt=360)
    airspeedMps: float | None = Field(None, ge=0)
    groundSpeedMps: float | None = Field(None, ge=0)
    verticalSpeedMps: float | None = None
    onGround: bool | None = None
    quality: Literal["observed", "calculated"] = "observed"

    @field_validator("timestamp")
    @classmethod
    def timestamp_must_be_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Telemetry timestamps must include a UTC offset")
        return value.astimezone(timezone.utc)


class FlightSession(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schemaVersion: Literal["1.0"] = "1.0"
    sessionId: UUID
    source: Source
    state: Lifecycle
    startedAt: datetime | None = None
    completedAt: datetime | None = None
    interruptedAt: datetime | None = None
    sampleCount: int = Field(ge=0)
    aircraft: str | None = None
    error: str | None = None

    @field_validator("startedAt", "completedAt", "interruptedAt")
    @classmethod
    def session_times_must_be_timezone_aware(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Flight session timestamps must include a UTC offset")
        return value.astimezone(timezone.utc)


class CompleteFlightRequest(BaseModel):
    """Identify the exact recording a completion request is allowed to finalize."""

    model_config = ConfigDict(extra="forbid")
    sessionId: UUID


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
