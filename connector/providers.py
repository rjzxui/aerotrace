"""Telemetry sources. Demo is deterministic-shaped simulated data, not real telemetry."""
import math
from typing import Protocol
from uuid import UUID
from uuid import UUID, uuid4

from .contracts import Source, TelemetrySample, utc_now


class TelemetryProvider(Protocol):
    """Common source marker. Samples always enter the same validation/storage path."""
    source: Source
    def next_sample(self, session_id: UUID | None = None) -> TelemetrySample: ...


class DemoTelemetryProvider:
    source = Source.DEMO
    def __init__(self, session_id: UUID):
        self.session_id = session_id
        self.index = 0

    def next_sample(self, session_id: UUID | None = None) -> TelemetrySample:
        i = self.index
        self.index += 1
        # A deliberately synthetic short loop over the Bay of Bengal.
        phase = i / 180 * math.tau
        return TelemetrySample(
            sampleId=uuid4(), sessionId=self.session_id,
            timestamp=utc_now(), source=Source.DEMO,
            latitudeDeg=15.0 + math.sin(phase) * 0.35,
            longitudeDeg=88.0 + math.cos(phase) * 0.55,
            altitudeM=9000 + math.sin(i / 24) * 80,
            headingDeg=(90 - math.degrees(phase)) % 360,
            airspeedMps=132 + math.sin(i / 11) * 2,
            groundSpeedMps=137 + math.sin(i / 9) * 2,
            verticalSpeedMps=math.cos(i / 24) * 3.3,
            onGround=False,
            quality="calculated",
        )
