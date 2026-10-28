import asyncio
import time
from uuid import uuid4

from fastapi.testclient import TestClient

import connector.api as api
from connector.contracts import FlightSession, Lifecycle, SimulatorState, Source, utc_now
from connector.lifecycle import LifecycleMachine
from connector.simconnect_provider import map_simvars
from connector.storage import SQLiteFlightStore


class FakeSimConnect:
    paused = False
    connected = True

    def connect(self):
        return None

    def is_connected(self):
        return self.connected

    def is_paused(self):
        return self.paused

    def next_sample(self, session_id):
        return map_simvars({
            "PLANE_LATITUDE": 37.6, "PLANE_LONGITUDE": -122.3,
            "PLANE_ALTITUDE": 2000, "PLANE_HEADING_DEGREES_TRUE": 0.2,
            "AIRSPEED_INDICATED": 80, "GROUND_VELOCITY": 85,
            "VERTICAL_SPEED": 0, "SIM_ON_GROUND": 0,
        }, session_id)

    def disconnect(self):
        self.connected = False


def wait_status(client, state, attempts=30):
    for _ in range(attempts):
        response = client.get("/api/status")
        if response.json()["simulator"]["state"] == state:
            return response.json()
        time.sleep(0.1)
    raise AssertionError(f"simulator did not reach {state}")


def reset_api(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "store", SQLiteFlightStore(tmp_path / "provider.sqlite3"))
    monkeypatch.setattr(api, "machine", LifecycleMachine())
    monkeypatch.setattr(api, "session", None)
    monkeypatch.setattr(api, "provider", None)
    monkeypatch.setattr(api, "sim_provider", None)
    monkeypatch.setattr(api, "selected_source", Source.DEMO)
    monkeypatch.setattr(api, "simulator_state", SimulatorState.NOT_DETECTED)
    monkeypatch.setattr(api, "simulator_message", None)
    monkeypatch.setattr(api, "sample_task", None)


def test_select_real_record_persist_complete_and_provider_lock(tmp_path, monkeypatch):
    reset_api(tmp_path, monkeypatch)
    fake = FakeSimConnect()
    monkeypatch.setattr(api, "SimConnectTelemetryProvider", lambda: fake)
    with TestClient(api.app) as client:
        selected = client.post("/api/provider/select/simconnect")
        assert selected.status_code == 200
        assert selected.json()["selectedSource"] == "simconnect"
        assert selected.json()["simulator"]["state"] == "connecting"
        wait_status(client, "waiting_for_flight")
        started = client.post("/api/flights/start")
        assert started.status_code == 200
        assert started.json()["source"] == "simconnect"
        current = client.get("/api/status").json()
        assert current["state"] == "recording", current
        assert client.post("/api/provider/select/demo").status_code == 409
        time.sleep(1.1)
        session_id = started.json()["session"]["sessionId"]
        samples = client.get(f"/api/flights/{session_id}/telemetry").json()
        assert samples and all(s["source"] == "simconnect" for s in samples)
        assert client.post("/api/flights/complete", json={"sessionId": session_id}).json()["state"] == "completed"


def test_paused_simulator_does_not_record_samples(tmp_path, monkeypatch):
    reset_api(tmp_path, monkeypatch)
    fake = FakeSimConnect()
    fake.paused = True
    monkeypatch.setattr(api, "SimConnectTelemetryProvider", lambda: fake)
    with TestClient(api.app) as client:
        assert client.post("/api/provider/select/simconnect").status_code == 200
        wait_status(client, "waiting_for_flight")
        started = client.post("/api/flights/start").json()
        time.sleep(1.1)
        samples = client.get(f"/api/flights/{started['session']['sessionId']}/telemetry").json()
        assert samples == []
        assert client.post("/api/flights/complete", json={"sessionId": started["session"]["sessionId"]}).status_code == 200


def test_no_demo_provider_used_for_simconnect_session(tmp_path, monkeypatch):
    reset_api(tmp_path, monkeypatch)
    fake = FakeSimConnect()
    monkeypatch.setattr(api, "SimConnectTelemetryProvider", lambda: fake)
    with TestClient(api.app) as client:
        client.post("/api/provider/select/simconnect")
        wait_status(client, "waiting_for_flight")
        started = client.post("/api/flights/start").json()
        assert api.provider is None
        assert started["session"]["source"] == "simconnect"
        client.post("/api/flights/complete", json={"sessionId": started["session"]["sessionId"]})


def test_failed_real_selection_does_not_fall_back_to_demo(tmp_path, monkeypatch):
    reset_api(tmp_path, monkeypatch)

    class Unavailable:
        def is_connected(self):
            return False

        def connect(self):
            raise RuntimeError("simulator unavailable")

        def disconnect(self):
            return None

    monkeypatch.setattr(api, "SimConnectTelemetryProvider", Unavailable)
    with TestClient(api.app) as client:
        assert client.post("/api/provider/select/simconnect").status_code == 200
        failed = wait_status(client, "error")
        assert failed["selectedSource"] == "simconnect"
        assert client.post("/api/demo/start").status_code == 409


def test_simulator_monitor_reconnects_without_changing_source(tmp_path, monkeypatch):
    reset_api(tmp_path, monkeypatch)
    recording = FlightSession(
        sessionId=uuid4(), source=Source.SIMCONNECT, state=Lifecycle.RECORDING,
        startedAt=utc_now(), completedAt=None, interruptedAt=None,
        sampleCount=0, aircraft="Mock Aircraft", error=None,
    )
    api.store.create_session(recording)
    monkeypatch.setattr(api, "session", recording)
    monkeypatch.setattr(api, "machine", LifecycleMachine(Lifecycle.RECORDING))

    async def scenario():
        disconnected = FakeSimConnect()
        disconnected.connected = False
        recovered = FakeSimConnect()
        monkeypatch.setattr(api, "sim_provider", disconnected)
        monkeypatch.setattr(api, "selected_source", Source.SIMCONNECT)
        monkeypatch.setattr(api, "simulator_state", SimulatorState.CONNECTED)
        attempts = iter((recovered,))
        monkeypatch.setattr(api, "SimConnectTelemetryProvider", lambda: next(attempts))
        task = asyncio.create_task(api.simulator_monitor())
        try:
            for _ in range(40):
                if api.sim_provider is recovered:
                    break
                await asyncio.sleep(0.1)
            assert api.sim_provider is recovered
            assert api.selected_source == Source.SIMCONNECT
            assert api.simulator_state == SimulatorState.RECORDING
            assert api.machine.state == Lifecycle.RECORDING
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    asyncio.run(scenario())
