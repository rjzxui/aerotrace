from datetime import datetime, timezone
from uuid import uuid4

import pytest
from pydantic import ValidationError

from connector.contracts import FlightSession, Lifecycle, Source, TelemetrySample
from connector.providers import DemoTelemetryProvider


def sample(**updates):
    payload = dict(sampleId=uuid4(), sessionId=uuid4(), timestamp=datetime.now(timezone.utc), source="demo", latitudeDeg=10, longitudeDeg=20, altitudeM=1000, headingDeg=120, airspeedMps=100, groundSpeedMps=None, verticalSpeedMps=None, onGround=None, quality="calculated")
    payload.update(updates)
    return TelemetrySample(**payload)


def test_missing_measures_are_null_and_units_are_explicit():
    item = sample()
    assert item.groundSpeedMps is None and item.onGround is None
    assert item.model_dump(mode="json")["altitudeM"] == 1000


def test_demo_provider_emits_contract_validated_synthetic_sample():
    session_id = uuid4()
    generated = DemoTelemetryProvider(session_id).next_sample()
    validated = TelemetrySample.model_validate(generated.model_dump())
    assert validated.sessionId == session_id
    assert validated.source == Source.DEMO
    assert validated.quality == "calculated"
    assert validated.latitudeDeg is not None and validated.longitudeDeg is not None


@pytest.mark.parametrize("field,value", [("latitudeDeg", 91), ("longitudeDeg", -181), ("headingDeg", 360), ("airspeedMps", -1)])
def test_invalid_values_are_rejected(field, value):
    with pytest.raises(ValidationError):
        sample(**{field: value})


def test_session_rejects_negative_sample_count():
    with pytest.raises(ValidationError):
        FlightSession(sessionId=uuid4(), source=Source.DEMO, state=Lifecycle.RECORDING, startedAt=datetime.now(timezone.utc), sampleCount=-1)
