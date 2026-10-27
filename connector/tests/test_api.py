import time
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from starlette.websockets import WebSocketDisconnect
import connector.api as api
from connector.contracts import TelemetrySample
from connector.lifecycle import LifecycleMachine


def test_health_and_demo_lifecycle(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "store", api.SQLiteFlightStore(tmp_path / "test.sqlite3"))
    monkeypatch.setattr(api, "machine", LifecycleMachine())
    monkeypatch.setattr(api, "session", None)
    monkeypatch.setattr(api, "provider", None)
    monkeypatch.setattr(api, "sample_task", None)
    with TestClient(api.app) as client:
        assert client.get("/health").json()["status"] == "ok"
        assert client.post("/api/flights/complete").status_code == 422
        assert client.post("/api/flights/complete", json={"sessionId": str(uuid4())}).status_code == 404
        started = client.post("/api/demo/start")
        assert started.status_code == 200
        assert started.json()["state"] == "recording"
        assert started.json()["source"] == "demo"
        assert client.post("/api/demo/start").status_code == 409
        session_id = started.json()["session"]["sessionId"]
        time.sleep(1.1)
        emitted = client.get(f"/api/flights/{session_id}/telemetry").json()
        assert emitted and emitted[0]["source"] == "demo"
        with client.websocket_connect("/ws/telemetry") as socket:
            streamed = TelemetrySample.model_validate(socket.receive_json())
        assert str(streamed.sessionId) == session_id
        assert streamed.source.value == "demo"
        completed = client.post("/api/flights/complete", json={"sessionId": session_id})
        assert completed.status_code == 200
        assert completed.json()["state"] == "completed"
        assert completed.json()["session"]["source"] == "demo"
        stored = client.get(f"/api/flights/{session_id}/telemetry").json()
        assert len(stored) == completed.json()["session"]["sampleCount"]
        # Completion is idempotent and retains the existing session ID.
        repeated = client.post("/api/flights/complete", json={"sessionId": session_id})
        assert repeated.status_code == 200
        assert repeated.json()["session"]["sessionId"] == session_id
        report = client.get(f"/api/flights/{session_id}")
        assert report.status_code == 200
        assert report.json()["recordingStatus"] == "complete"
        assert report.json()["summary"]["sampleCount"] == len(stored)
        assert client.get(f"/api/flights/{session_id}/telemetry?offset=0&limit=1").json() == stored[:1]
        assert client.get(f"/api/flights/{session_id}/analysis").status_code == 200
        assert client.get(f"/api/flights/{session_id}/events").status_code == 200
        assert client.get(f"/api/flights/{session_id}/phases").status_code == 200


def test_old_completion_retry_cannot_finalize_a_newer_session(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "store", api.SQLiteFlightStore(tmp_path / "targeted-complete.sqlite3"))
    monkeypatch.setattr(api, "machine", LifecycleMachine())
    monkeypatch.setattr(api, "session", None)
    monkeypatch.setattr(api, "provider", None)
    monkeypatch.setattr(api, "sample_task", None)
    with TestClient(api.app) as client:
        first = client.post("/api/demo/start").json()["session"]["sessionId"]
        assert client.post("/api/flights/complete", json={"sessionId": first}).json()["state"] == "completed"

        second = client.post("/api/demo/start").json()["session"]["sessionId"]
        assert second != first
        repeated = client.post("/api/flights/complete", json={"sessionId": first})

        assert repeated.status_code == 200
        assert repeated.json()["state"] == "completed"
        assert repeated.json()["session"]["sessionId"] == first
        assert client.get("/api/status").json()["session"]["sessionId"] == second
        assert client.get("/api/status").json()["state"] == "recording"
        assert client.post("/api/flights/complete", json={"sessionId": second}).json()["state"] == "completed"


def test_cross_site_mutations_and_websocket_connections_are_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "store", api.SQLiteFlightStore(tmp_path / "origin-guard.sqlite3"))
    monkeypatch.setattr(api, "machine", LifecycleMachine())
    monkeypatch.setattr(api, "session", None)
    monkeypatch.setattr(api, "provider", None)
    monkeypatch.setattr(api, "sample_task", None)
    with TestClient(api.app) as client:
        denied = client.post("/api/demo/start", headers={"Origin": "https://attacker.example"})
        assert denied.status_code == 403
        assert client.get("/api/flights").json() == []
        with pytest.raises(WebSocketDisconnect) as caught:
            with client.websocket_connect("/ws/telemetry", headers={"origin": "https://attacker.example"}):
                pass
        assert caught.value.code == 1008


def test_telemetry_endpoint_bounds_unspecified_page_size(tmp_path, monkeypatch):
    from datetime import datetime, timedelta, timezone

    from connector.contracts import FlightSession, Lifecycle, Source, TelemetrySample

    store = api.SQLiteFlightStore(tmp_path / "bounded-telemetry.sqlite3")
    session = FlightSession(
        sessionId=uuid4(), source=Source.DEMO, state=Lifecycle.RECORDING,
        startedAt=datetime.now(timezone.utc), completedAt=None,
        interruptedAt=None, sampleCount=0, aircraft=None, error=None,
    )
    store.create_session(session)
    base = TelemetrySample(
        sampleId=uuid4(),
        sessionId=session.sessionId, timestamp=datetime.now(timezone.utc), source=Source.DEMO,
        latitudeDeg=0, longitudeDeg=0, altitudeM=1, headingDeg=0,
        airspeedMps=0, groundSpeedMps=0, verticalSpeedMps=0, onGround=True,
        quality="calculated",
    )
    with store._connection() as db:
        rows = []
        for index in range(1001):
            sample = base.model_copy(update={
                "sampleId": uuid4(),
                "timestamp": base.timestamp + timedelta(seconds=index),
            })
            rows.append((str(sample.sampleId), str(sample.sessionId), sample.timestamp.isoformat(), sample.model_dump_json()))
        db.executemany("INSERT INTO telemetry(sample_id,session_id,timestamp,payload) VALUES(?,?,?,?)", rows)
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(api, "machine", LifecycleMachine(Lifecycle.RECORDING))
    monkeypatch.setattr(api, "session", session)
    with TestClient(api.app) as client:
        response = client.get(f"/api/flights/{session.sessionId}/telemetry")
        assert response.status_code == 200
        assert len(response.json()) == api.DEFAULT_TELEMETRY_PAGE_SIZE
        assert len(client.get(f"/api/flights/{session.sessionId}/telemetry?offset=1000&limit=1").json()) == 1
