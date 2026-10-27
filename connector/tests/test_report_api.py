from datetime import datetime, timezone
from uuid import uuid4

from fastapi.testclient import TestClient

import connector.api as api
from connector.contracts import FlightSession, Lifecycle, Source, TelemetrySample
from connector.lifecycle import LifecycleMachine
from connector.storage import SQLiteFlightStore


def test_restart_exposes_session_as_interrupted_in_status_and_report(tmp_path, monkeypatch):
    store = SQLiteFlightStore(tmp_path / "api-restart.sqlite3")
    session = FlightSession(
        sessionId=uuid4(), source=Source.SIMCONNECT, state=Lifecycle.RECORDING,
        startedAt=datetime.now(timezone.utc), completedAt=None, interruptedAt=None,
        sampleCount=0, aircraft="Mock Aircraft", error=None,
    )
    store.create_session(session)
    sample = TelemetrySample(
        sampleId=uuid4(), sessionId=session.sessionId, timestamp=datetime.now(timezone.utc),
        source=Source.SIMCONNECT, latitudeDeg=40, longitudeDeg=-70, altitudeM=1000,
        headingDeg=90, airspeedMps=80, groundSpeedMps=80, verticalSpeedMps=0,
        onGround=False, quality="observed",
    )
    store.record_sample(sample)
    monkeypatch.setattr(api, "store", SQLiteFlightStore(tmp_path / "api-restart.sqlite3"))
    monkeypatch.setattr(api, "session", None)
    monkeypatch.setattr(api, "machine", LifecycleMachine())
    with TestClient(api.app) as client:
        status = client.get("/api/status").json()
        assert status["state"] == "interrupted"
        assert status["session"]["state"] == "interrupted"
        assert status["session"]["completedAt"] is None
        report = client.get(f"/api/flights/{session.sessionId}").json()
        assert report["recordingStatus"] == "interrupted"
        assert report["summary"]["sampleCount"] == 1
        assert client.post("/api/flights/complete", json={"sessionId": str(session.sessionId)}).status_code == 409
